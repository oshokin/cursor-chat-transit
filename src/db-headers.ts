import { uriFromString, workspaceKey } from './core';
import {
  asComposerHeader,
  readComposerHeadersTable,
  readItemJson,
} from './db-read';
import type {
  ComposerHeader,
  Layout,
  SqliteConn,
  WorkspaceIdentity,
  WorkspaceKind,
} from './types';

/** Kind from a stored header URI; `.code-workspace` is a workspace file, not a folder. */
export function headerKindFromUri(pathValue: string): WorkspaceKind {
  return /\.code-workspace$/i.test(pathValue) ? 'workspace' : 'folder';
}

/** Identity key from a header `workspaceIdentifier`, or null when it cannot be parsed. */
export function headerWorkspaceKey(
  ident: NonNullable<ComposerHeader['workspaceIdentifier']>,
): string | null {
  const raw = ident.uri as unknown;

  if (typeof raw === 'string') {
    try {
      const uri = uriFromString(raw);

      return workspaceKey(headerKindFromUri(uri.path), uri);
    } catch {
      return null;
    }
  }

  if (!raw || typeof raw !== 'object') return null;

  const uri = raw as {
    /** URI scheme such as `file` or `vscode-remote`. */
    scheme?: unknown;
    /** Host or SSH authority. */
    authority?: unknown;
    /** Decoded URI path. */
    path?: unknown;
    /** Optional query string. */
    query?: unknown;
    /** Optional fragment. */
    fragment?: unknown;
  };

  if (typeof uri.scheme !== 'string' || typeof uri.path !== 'string')
    return null;

  try {
    return workspaceKey(headerKindFromUri(uri.path), {
      scheme: uri.scheme,
      authority: typeof uri.authority === 'string' ? uri.authority : '',
      path: uri.path,
      query: typeof uri.query === 'string' ? uri.query : '',
      fragment: typeof uri.fragment === 'string' ? uri.fragment : '',
    });
  } catch {
    return null;
  }
}

/** True if the header belongs to this storage id or workspace URI. */
export function matchesWorkspace(
  header: ComposerHeader,
  storageId: string | undefined,
  identity: WorkspaceIdentity | undefined,
): boolean {
  const ident = header.workspaceIdentifier || {};

  if (storageId && ident.id && ident.id === storageId) return true;
  if (!identity) return false;
  const headerKey = headerWorkspaceKey(ident);

  if (!headerKey) return false;

  return headerKey === workspaceKey(identity.kind, identity.uri);
}

/**
 * How one header relates to the destination workspace.
 * `match` is the same test export uses. `other` is a different workspace.
 * `unbound` has no workspace claim. `conflict` is an unusable or contradictory claim.
 */
export type WorkspaceBinding = 'match' | 'other' | 'unbound' | 'conflict';

/** Classify a header against one destination. A legacy row with no claim stays unbound. */
export function workspaceBinding(
  header: ComposerHeader,
  storageId: string | undefined,
  identity: WorkspaceIdentity | undefined,
): WorkspaceBinding {
  const ident = header.workspaceIdentifier || {};
  const id = typeof ident.id === 'string' ? ident.id : '';
  const rawUri = ident.uri as unknown;

  const uriPresent =
    rawUri !== undefined &&
    rawUri !== null &&
    !(typeof rawUri === 'string' && rawUri === '');

  const uriKey = uriPresent ? headerWorkspaceKey(ident) : null;
  const idMatch = !!(storageId && id && id === storageId);

  if (uriPresent && !uriKey && !idMatch) return 'conflict';

  if (idMatch && uriPresent && identity) {
    const expected = workspaceKey(identity.kind, identity.uri);

    if (!uriKey || uriKey !== expected) return 'conflict';
  }

  if (matchesWorkspace(header, storageId, identity)) return 'match';
  if (!id && !uriPresent) return 'unbound';

  return 'other';
}

/** Where a merged header originated; table rows outrank blobs and workspace lists. */
export type HeaderMergeSource = 'table' | 'blob' | 'workspace' | 'selected';

/** Union headers by composerId; table metadata outranks blob and workspace lists. */
export function mergeHeaders(
  sources: Array<{
    /** Headers from this source, if any were read. */
    records?: ComposerHeader[] | null;
    /** Where these headers were read from; table metadata outranks blobs. */
    source: HeaderMergeSource;
  }>,
): ComposerHeader[] {
  const byId = new Map<string, { record: ComposerHeader; rank: number }>();

  const rank: Record<HeaderMergeSource, number> = {
    table: 3,
    blob: 2,
    workspace: 1,
    selected: 0,
  };

  for (const { records, source } of sources) {
    const r = rank[source] ?? 0;

    for (const rec of records || []) {
      if (!rec || !rec.composerId || rec.composerId === 'empty-state-draft')
        continue;
      const prev = byId.get(rec.composerId);

      if (!prev || r > prev.rank)
        byId.set(rec.composerId, { record: rec, rank: r });
    }
  }

  // A sparse higher-priority header must not erase a known name.
  // Preserve explicit empty names; only recover an absent name.
  const names = new Map<string, { name: string; rank: number }>();

  for (const { records, source } of sources) {
    for (const rec of records || []) {
      if (!rec || typeof rec.name !== 'string' || !rec.name.trim()) continue;
      const prev = names.get(rec.composerId);

      if (!prev || rank[source] > prev.rank) {
        names.set(rec.composerId, { name: rec.name, rank: rank[source] });
      }
    }
  }

  return [...byId.values()].map(({ record }) => {
    const fallback = names.get(record.composerId);

    return record.name === undefined && fallback
      ? { ...record, name: fallback.name }
      : record;
  });
}

/** Collect composer headers from workspace + global sources for one identity. */
export async function resolveComposers(
  connWs: SqliteConn,
  connGl: SqliteConn,
  opts: {
    /** Cursor workspace storage id for this window. */
    storageId: string;
    /** Parsed workspace identity when workspace.json is usable. */
    identity?: WorkspaceIdentity;
    /** Detected workspace schema. */
    layoutWs: Layout;
    /** Detected global schema. */
    layoutGl: Layout;
    /** When true, merge timestamp columns from composerHeaders into headers. */
    includeColumnDates?: boolean;
  },
): Promise<ComposerHeader[]> {
  const { storageId, identity, layoutWs, layoutGl } = opts;

  const sources: Array<{
    records: ComposerHeader[];
    source: HeaderMergeSource;
  }> = [];

  if (layoutWs.itemTable) {
    const data = await readItemJson(connWs, 'composer.composerData');
    const all = data?.allComposers;

    if (Array.isArray(all)) {
      sources.push({
        source: 'workspace',
        records: all
          .map(asComposerHeader)
          .filter((h): h is ComposerHeader => !!h),
      });
    }
  }

  if (layoutWs.composerHeaders) {
    sources.push({
      source: 'table',
      records: await readComposerHeadersTable(
        connWs,
        layoutWs.headerColumns,
        opts.includeColumnDates,
      ),
    });
  }

  if (layoutGl.composerHeaders) {
    const all = await readComposerHeadersTable(
      connGl,
      layoutGl.headerColumns,
      opts.includeColumnDates,
    );

    sources.push({
      source: 'table',
      records: all.filter((h) => matchesWorkspace(h, storageId, identity)),
    });
  }

  if (layoutGl.itemTable) {
    const blob = await readItemJson(connGl, 'composer.composerHeaders');
    const all = blob?.allComposers;

    if (Array.isArray(all)) {
      sources.push({
        source: 'blob',
        records: all
          .map(asComposerHeader)
          .filter((h): h is ComposerHeader => !!h)
          .filter((h) => matchesWorkspace(h, storageId, identity)),
      });
    }
  }

  return mergeHeaders(sources);
}
