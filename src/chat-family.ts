import type { ComposerHeader } from './types';

/** One chat in a subagent family. Message bodies are not stored here. */
export interface ChatFamilyNode {
  /** Composer id of this chat. */
  composerId: string;
  /** Immediate parent, when the link is consistent. */
  parentComposerId?: string;
  /** Root of the family, when the link is consistent. */
  rootComposerId?: string;
  /** Direct children named by a consistent link. */
  childComposerIds: readonly string[];
  /** Recognized subagent type name, when the header stored one. */
  subagentTypeName?: string;
  /** Root, a linked child, or a subagent whose parent cannot be used. */
  relation: 'root' | 'child' | 'unresolved';
}

/** One relationship that export, import, or the tree must not guess through. */
export interface FamilyDiagnostic {
  /** Why this chat is not a normal root or child. */
  code: 'cycle' | 'self-parent' | 'conflict' | 'missing-parent' | 'unresolved';
  /** Chat the diagnostic is about. */
  composerId: string;
  /** Short reason for logs and tests. */
  detail: string;
}

/** Built from headers already loaded. Bodies are optional extra metadata. */
export interface FamilyGraph {
  /** Every input chat, keyed by composer id. */
  nodes: Map<string, ChatFamilyNode>;
  /** Problems that block treating a link as confirmed. */
  diagnostics: FamilyDiagnostic[];
}

interface RawLink {
  composerId: string;
  parent?: string;
  root?: string;
  children: string[];
  subagentTypeName?: string;
  isSubagent: boolean;
}

/** Read the supported subagent fields. Unknown shapes contribute no parent. */
function rawLink(header: ComposerHeader): RawLink {
  const info = header.subagentInfo;

  const record =
    info && typeof info === 'object' && !Array.isArray(info)
      ? (info as Record<string, unknown>)
      : undefined;

  const parent =
    typeof record?.parentComposerId === 'string'
      ? record.parentComposerId
      : undefined;

  const root =
    typeof record?.rootParentConversationId === 'string'
      ? record.rootParentConversationId
      : undefined;

  const typeName =
    typeof record?.subagentTypeName === 'string'
      ? record.subagentTypeName
      : undefined;

  const listed = Array.isArray(header.subagentComposerIds)
    ? header.subagentComposerIds.filter(
        (id): id is string => typeof id === 'string' && !!id,
      )
    : [];

  return {
    composerId: header.composerId,
    parent,
    root,
    children: [...new Set(listed)],
    subagentTypeName: typeName,
    isSubagent: header.isSubagent === true || !!parent,
  };
}

/** Build parent and child links. Conflicting sides are diagnostics, not a guess. */
export function buildFamily(headers: readonly ComposerHeader[]): FamilyGraph {
  const raw = new Map<string, RawLink>();

  for (const header of headers) raw.set(header.composerId, rawLink(header));

  const diagnostics: FamilyDiagnostic[] = [];
  const parentOf = new Map<string, string>();
  const childrenOf = new Map<string, Set<string>>();

  /** Record one directed edge when both ends exist and do not disagree. */
  const link = (parent: string, child: string) => {
    if (parent === child) {
      diagnostics.push({
        code: 'self-parent',
        composerId: child,
        detail: 'A chat lists itself as its parent.',
      });

      return;
    }

    const existing = parentOf.get(child);

    if (existing && existing !== parent) {
      diagnostics.push({
        code: 'conflict',
        composerId: child,
        detail: 'The chat has two different parents.',
      });

      parentOf.delete(child);

      return;
    }

    parentOf.set(child, parent);
    const kids = childrenOf.get(parent) || new Set<string>();

    kids.add(child);
    childrenOf.set(parent, kids);
  };

  for (const item of raw.values()) {
    if (item.parent && raw.has(item.parent)) link(item.parent, item.composerId);
    else if (item.parent)
      diagnostics.push({
        code: 'missing-parent',
        composerId: item.composerId,
        detail: 'The parent id is not in this workspace list.',
      });

    for (const child of item.children) {
      if (!raw.has(child)) continue;
      const childParent = raw.get(child)?.parent;

      if (childParent && childParent !== item.composerId) {
        diagnostics.push({
          code: 'conflict',
          composerId: child,
          detail:
            'The parent list and the child record name different parents.',
        });

        continue;
      }

      link(item.composerId, child);
    }
  }

  const cyclic = new Set<string>();

  for (const start of parentOf.keys()) {
    const seen = new Set<string>();
    let cursor: string | undefined = start;

    while (cursor && parentOf.has(cursor)) {
      if (seen.has(cursor)) {
        for (const id of seen) cyclic.add(id);
        break;
      }

      seen.add(cursor);
      cursor = parentOf.get(cursor);
    }
  }

  for (const id of cyclic) {
    diagnostics.push({
      code: 'cycle',
      composerId: id,
      detail: 'The parent links form a cycle.',
    });

    parentOf.delete(id);
  }

  const conflicted = new Set(
    diagnostics
      .filter(
        (item) =>
          item.code === 'conflict' ||
          item.code === 'cycle' ||
          item.code === 'self-parent',
      )
      .map((item) => item.composerId),
  );

  for (const id of conflicted) parentOf.delete(id);

  const nodes = new Map<string, ChatFamilyNode>();

  for (const item of raw.values()) {
    const parent = conflicted.has(item.composerId)
      ? undefined
      : parentOf.get(item.composerId);

    const kids = [...(childrenOf.get(item.composerId) || [])].filter(
      (id) => parentOf.get(id) === item.composerId && !conflicted.has(id),
    );

    let root = item.composerId;
    const walk = new Set<string>();
    let cursor = parent;

    while (cursor && !walk.has(cursor)) {
      walk.add(cursor);
      root = cursor;
      cursor = parentOf.get(cursor);
    }

    const unresolved =
      !parent &&
      (item.isSubagent ||
        conflicted.has(item.composerId) ||
        diagnostics.some(
          (itemDiagnostic) => itemDiagnostic.composerId === item.composerId,
        ));

    nodes.set(item.composerId, {
      composerId: item.composerId,
      parentComposerId: parent,
      rootComposerId: parent ? root : undefined,
      childComposerIds: kids,
      subagentTypeName: item.subagentTypeName,
      relation: parent ? 'child' : unresolved ? 'unresolved' : 'root',
    });
  }

  return { nodes, diagnostics };
}

/** Composer ids to export for a selection. A child expands to its whole root family. */
export function exportFamilyIds(
  headers: readonly ComposerHeader[],
  /** Selected composer ids. Undefined means every header. */
  selectedIds?: readonly string[],
): { ids: string[]; diagnostics: FamilyDiagnostic[] } {
  const graph = buildFamily(headers);

  const wanted = new Set(
    selectedIds ?? headers.map((header) => header.composerId),
  );

  const out = new Set<string>();

  /** Add a root and every confirmed descendant. */
  const addTree = (id: string) => {
    const stack = [id];
    const seen = new Set<string>();

    while (stack.length) {
      const current = stack.pop();

      if (!current || seen.has(current)) continue;
      seen.add(current);
      out.add(current);

      for (const child of graph.nodes.get(current)?.childComposerIds || [])
        stack.push(child);
    }
  };

  for (const id of wanted) {
    const node = graph.nodes.get(id);

    if (!node) continue;
    if (node.relation === 'child' && node.rootComposerId)
      addTree(node.rootComposerId);
    else addTree(id);
  }

  return { ids: [...out], diagnostics: graph.diagnostics };
}

/** Direct children of one chat, in header order. */
export function directChildren(
  headers: readonly ComposerHeader[],
  parentId: string,
): ComposerHeader[] {
  const graph = buildFamily(headers);
  const kids = new Set(graph.nodes.get(parentId)?.childComposerIds || []);

  return headers.filter((header) => kids.has(header.composerId));
}

/** Headers that belong on the workspace row: roots and unresolved chats. */
export function topLevelChats(
  headers: readonly ComposerHeader[],
): ComposerHeader[] {
  const graph = buildFamily(headers);

  return headers.filter((header) => {
    const node = graph.nodes.get(header.composerId);

    return !node || node.relation !== 'child';
  });
}

/** Rewrite only the known family id fields. Other strings stay as stored. */
export function remapFamilyRecord(
  /** Composer or header record. */
  record: Record<string, unknown>,
  /** Source composer id to the destination composer id. */
  composerIds: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const next = { ...record };
  const info = next.subagentInfo;

  if (info && typeof info === 'object' && !Array.isArray(info)) {
    const copy = { ...(info as Record<string, unknown>) };

    for (const key of ['parentComposerId', 'rootParentConversationId']) {
      const value = copy[key];

      if (typeof value === 'string' && composerIds.has(value))
        copy[key] = composerIds.get(value);
    }

    next.subagentInfo = copy;
  }

  if (Array.isArray(next.subagentComposerIds)) {
    next.subagentComposerIds = next.subagentComposerIds.map((id) =>
      typeof id === 'string' && composerIds.has(id) ? composerIds.get(id) : id,
    );
  }

  return next;
}

/** Descendant count, not the direct-child count. */
export function descendantCount(
  graph: FamilyGraph,
  composerId: string,
): number {
  let count = 0;
  const stack = [...(graph.nodes.get(composerId)?.childComposerIds || [])];
  const seen = new Set<string>();

  while (stack.length) {
    const id = stack.pop();

    if (!id || seen.has(id)) continue;
    seen.add(id);
    count += 1;

    for (const child of graph.nodes.get(id)?.childComposerIds || [])
      stack.push(child);
  }

  return count;
}

/** Parent chats that still have unselected descendants stay in the tree. */
export function narrowDeletion(
  headers: readonly ComposerHeader[],
  selectedIds: readonly string[],
): {
  /** Composer ids that can be deleted without leaving a broken parent. */
  deleteIds: string[];
  /** Selected parents withheld because a descendant was not selected. */
  kept: Array<{ composerId: string; name?: string; unselected: number }>;
} {
  const graph = buildFamily(headers);
  const selected = new Set(selectedIds);
  const drop = new Set<string>();

  const kept: Array<{ composerId: string; name?: string; unselected: number }> =
    [];

  for (const id of selected) {
    let unselected = 0;
    const stack = [...(graph.nodes.get(id)?.childComposerIds || [])];
    const seen = new Set<string>();

    while (stack.length) {
      const child = stack.pop();

      if (!child || seen.has(child)) continue;
      seen.add(child);
      if (!selected.has(child)) unselected += 1;

      for (const grandchild of graph.nodes.get(child)?.childComposerIds || [])
        stack.push(grandchild);
    }

    if (!unselected) continue;
    drop.add(id);

    kept.push({
      composerId: id,
      name: headers.find((header) => header.composerId === id)?.name,
      unselected,
    });
  }

  return {
    deleteIds: selectedIds.filter((id) => !drop.has(id)),
    kept,
  };
}

/** Sentence for a parent that stays because its subagents were not all selected. */
export function keptParentNote(
  kept: readonly { unselected: number }[],
): string {
  if (!kept.length) return '';
  const unselected = kept.reduce((sum, row) => sum + row.unselected, 0);

  return `Parent kept: ${unselected} subagent${unselected === 1 ? ' was' : 's were'} not selected`;
}

/** Ancestors whose membership list must be rewritten when a child is deleted. */
export function parentsToUpdate(
  headers: readonly ComposerHeader[],
  deleteIds: readonly string[],
): string[] {
  const deleting = new Set(deleteIds);
  const parents = new Set<string>();

  for (const header of headers) {
    if (!deleting.has(header.composerId)) continue;
    const parent = header.subagentInfo?.parentComposerId;

    if (typeof parent === 'string' && parent && !deleting.has(parent))
      parents.add(parent);
  }

  for (const header of headers) {
    if (deleting.has(header.composerId)) continue;

    if (header.subagentComposerIds?.some((id) => deleting.has(id)))
      parents.add(header.composerId);
  }

  return [...parents];
}

/** Drop deleted composer ids from a parent membership list. Other fields stay. */
export function withoutDeletedSubagents<T extends Record<string, unknown>>(
  record: T,
  deleted: ReadonlySet<string>,
): T {
  const list = record.subagentComposerIds;

  if (!Array.isArray(list)) return record;

  const next = list.filter((id) => typeof id !== 'string' || !deleted.has(id));

  if (next.length === list.length) return record;

  return { ...record, subagentComposerIds: next };
}

/** One catalog row after the per-chat import decision. */
export interface FamilyImportRow {
  /** Source composer id. */
  sourceId: string;
  /** create copies this snapshot. skip leaves the existing copy. */
  decision: 'create' | 'skip';
  /** Header fields that name the family. */
  header: ComposerHeader;
}

/**
 * A changed member copies the whole family.
 * A child whose parent is not in the archive is not imported alone.
 */
export function familyImportAdjustments(rows: readonly FamilyImportRow[]): {
  /** Skip rows that must become a new family copy. */
  promote: string[];
  /** Create rows that must be skipped because the parent is absent. */
  drop: string[];
} {
  const present = new Map(rows.map((row) => [row.sourceId, row]));
  const dropped = new Set<string>();

  for (const row of rows) {
    const parent = row.header.subagentInfo?.parentComposerId;

    if (
      row.decision === 'create' &&
      typeof parent === 'string' &&
      parent &&
      !present.has(parent)
    )
      dropped.add(row.sourceId);
  }

  const graph = buildFamily(
    rows.filter((row) => !dropped.has(row.sourceId)).map((row) => row.header),
  );

  const promote = new Set<string>();
  const seen = new Set<string>();

  for (const row of rows) {
    if (dropped.has(row.sourceId) || seen.has(row.sourceId)) continue;
    const info = graph.nodes.get(row.sourceId);

    const root =
      info?.relation === 'child' && info.rootComposerId
        ? info.rootComposerId
        : row.sourceId;

    const members: string[] = [];
    const stack = [root];
    const walked = new Set<string>();

    while (stack.length) {
      const id = stack.pop();

      if (!id || walked.has(id) || !present.has(id) || dropped.has(id))
        continue;
      walked.add(id);
      seen.add(id);
      members.push(id);

      for (const child of graph.nodes.get(id)?.childComposerIds || [])
        stack.push(child);
    }

    const creates = members.filter(
      (id) => present.get(id)?.decision === 'create',
    );

    if (!creates.length) continue;

    for (const id of members)
      if (present.get(id)?.decision === 'skip') promote.add(id);
  }

  return { promote: [...promote], drop: [...dropped] };
}
