import fs from 'node:fs';
import * as db from './db';
import {
  blobKeysFromComposerBody,
  imageUuidsFromBubbles,
  resolveAttachmentPath,
} from './dependencies';
import {
  classifyTargetObservation,
  formatTargetFacts,
  sha256Text,
  type TargetFacts,
  type TargetProbeState,
} from './import-policy';
import {
  completePendingImport,
  type ImportJournal,
  type PendingImportChat,
} from './journal';
import { planFilenamesFromChat, readPlanFile } from './plans';
import { sha256Hex } from './resource-bytes';
import type {
  BubbleRecord,
  ExportObject,
  ExportResources,
  Layout,
  SqliteConn,
  WorkspaceEntry,
} from './types';
import { TransferError } from './types';

/** Fail closed so a half-finished import is never treated as a new copy. */
export function needsAttention(
  message: string,
  detail?: string,
): TransferError {
  const err = new TransferError(message);
  err.code = 'NEEDS_ATTENTION';
  if (detail) {
    err.detail = detail.replace(/[\r\n\t]/g, ' ').slice(0, 800);
  }
  return err;
}

/** Pending journal rows from a clone: ids, hashes, and expected resources. */
export function pendingChatsFromClone(opts: {
  /** Cloned export object whose destination ids are already assigned. */
  cloned: ExportObject;
  /** Source composer id to destination composer id. */
  composerMap: Map<string, string>;
  /** Compound source bubble key to destination bubble id. */
  bubbleMap: Map<string, string>;
  /** Snapshot fingerprints keyed by source composer id. */
  snapshotBySource: Map<string, string>;
  /** Completeness of each source chat in this batch. */
  quality: Map<string, 'complete' | 'history-only'>;
}): PendingImportChat[] {
  const chats: PendingImportChat[] = [];
  for (const [sourceId, targetId] of opts.composerMap) {
    const bubbleMap: Array<[string, string]> = [];
    for (const [compound, newId] of opts.bubbleMap) {
      const sep = compound.indexOf('\0');
      if (sep < 0 || compound.slice(0, sep) !== sourceId) continue;
      bubbleMap.push([compound.slice(sep + 1), newId]);
    }
    const body = opts.cloned.composers[targetId] || '';
    const expectedBubbles: Array<[string, string]> = (
      opts.cloned.bubbles?.[targetId] || []
    ).map((row) => [row.bubbleId, sha256Text(row.value)]);
    chats.push({
      sourceComposerId: sourceId,
      snapshotHash: opts.snapshotBySource.get(sourceId) || '',
      targetComposerId: targetId,
      bubbleMap,
      expectedComposerHash: sha256Text(body),
      expectedBubbles,
      expectedResources: expectedResourcesFromChat(
        body,
        opts.cloned.bubbles?.[targetId],
        opts.cloned.resources || { kv: [], attachments: [], plans: [] },
      ),
      quality: opts.quality.get(sourceId) || 'complete',
    });
  }
  return chats;
}

/** Resource checksums the pending record must still find on disk after commit. */
export function expectedResourcesFromChat(
  body: string,
  bubbles: BubbleRecord[] | undefined,
  resources: ExportResources,
): NonNullable<PendingImportChat['expectedResources']> {
  const out: NonNullable<PendingImportChat['expectedResources']> = [];
  const seen = new Set<string>();
  /** Record one unique kv, image, or plan checksum the pending row must keep. */
  const add = (kind: 'kv' | 'image' | 'plan', id: string, sha256: string) => {
    const key = `${kind}\0${id}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ kind, id, sha256 });
  };
  const kvByKey = new Map(resources.kv.map((row) => [row.key, row]));
  const blobs = blobKeysFromComposerBody(body);
  if (blobs.status === 'ok') {
    for (const key of blobs.keys) {
      const row = kvByKey.get(key);
      if (row) add('kv', key, row.value.sha256);
    }
  }
  const images = new Map(
    resources.attachments.map((row) => [row.id.toLowerCase(), row]),
  );
  try {
    for (const uuid of imageUuidsFromBubbles(bubbles)) {
      const row = images.get(uuid.toLowerCase());
      if (row) add('image', uuid, row.sha256);
    }
  } catch {
    /* clone already rejected invalid attachment ids */
  }
  const plans = new Map(
    (resources.plans || []).map((row) => [row.filename, row]),
  );
  for (const name of planFilenamesFromChat(body, bubbles)) {
    const row = plans.get(name);
    if (row) add('plan', name, row.sha256);
  }
  return out;
}

/** Drop a vanished pending batch, complete an exact one, or stop for inspection. */
export async function reconcilePending(
  journal: ImportJournal,
  opts: {
    /** Destination workspace whose databases are being reconciled. */
    workspace: WorkspaceEntry;
    /** Open workspace database connection. */
    connWs: SqliteConn;
    /** Open global database connection. */
    connGl: SqliteConn;
    /** Detected workspace schema. */
    wsInfo: Layout;
    /** Detected global schema. */
    glInfo: Layout;
    /** Directory that should still hold pending plan files. */
    plansDir: string;
  },
): Promise<ImportJournal> {
  const pending = journal.pending;
  if (!pending) return journal;
  const states: Array<'missing' | 'exact' | 'changed'> = [];
  for (const chat of pending.chats) {
    states.push(await pendingChatMatch(chat, opts));
  }
  if (states.every((state) => state === 'missing')) {
    return {
      version: 1,
      targetKey: journal.targetKey,
      receipts: journal.receipts,
    };
  }
  if (states.every((state) => state === 'exact')) {
    return completePendingImport(journal);
  }

  const detail = pending.chats
    .map(
      (chat, index) =>
        `pendingTarget=${chat.targetComposerId} match=${states[index]}`,
    )
    .join(' ');
  throw needsAttention(
    'The previous import needs checking. No new copies were created.',
    `pending phase=${pending.phase} ${detail}`,
  );
}

/** Compare one pending chat with the live databases and plan files. */
export async function pendingChatMatch(
  chat: PendingImportChat,
  opts: {
    /** Destination workspace whose databases are being compared. */
    workspace: WorkspaceEntry;
    /** Open workspace database connection. */
    connWs: SqliteConn;
    /** Open global database connection. */
    connGl: SqliteConn;
    /** Detected workspace schema. */
    wsInfo: Layout;
    /** Detected global schema. */
    glInfo: Layout;
    /** Directory that should still hold pending plan files. */
    plansDir: string;
  },
): Promise<'missing' | 'exact' | 'changed'> {
  const body = await db.readKvText(
    opts.connGl,
    `composerData:${chat.targetComposerId}`,
  );
  const bubbleIds = await db.listBubbleIds(opts.connGl, chat.targetComposerId);
  const mentioned = await composerMentioned(chat.targetComposerId, opts);
  if (!body && bubbleIds.size === 0 && !mentioned) return 'missing';
  if (!body) return 'changed';
  if (sha256Text(body) !== chat.expectedComposerHash) return 'changed';
  if (bubbleIds.size !== chat.expectedBubbles.length) return 'changed';
  const expected = new Map(chat.expectedBubbles);
  for (const [bubbleId, expectedHash] of expected) {
    if (!bubbleIds.has(bubbleId)) return 'changed';
    const row = await db.readKvText(
      opts.connGl,
      `bubbleId:${chat.targetComposerId}:${bubbleId}`,
    );
    if (!row || sha256Text(row) !== expectedHash) return 'changed';
  }
  const bound = await probeTargetComposer({
    targetComposerId: chat.targetComposerId,
    ...opts,
  });
  // Global headers alone are not evidence that the workspace commit happened.
  if (bound !== 'available' || !mentioned) return 'changed';
  if (!Array.isArray(chat.expectedResources)) return 'changed';
  for (const dep of chat.expectedResources) {
    if (!(await pendingResourceMatches(dep, opts))) return 'changed';
  }
  return 'exact';
}

/** True when the stored kv, image, or plan bytes match the pending checksum. */
export async function pendingResourceMatches(
  dep: NonNullable<PendingImportChat['expectedResources']>[number],
  opts: {
    /** Destination workspace used to resolve attachment files. */
    workspace: WorkspaceEntry;
    /** Open global database connection. */
    connGl: SqliteConn;
    /** Directory that should still hold pending plan files. */
    plansDir: string;
  },
): Promise<boolean> {
  if (dep.kind === 'kv') {
    const stored = await db.readKvBytes(opts.connGl, dep.id);
    return Boolean(stored && sha256Hex(stored.bytes) === dep.sha256);
  }
  if (dep.kind === 'image') {
    const found = await resolveAttachmentPath(opts.workspace, dep.id);
    if (!found) return false;
    const bytes = await fs.promises.readFile(found.filePath);
    return sha256Hex(bytes) === dep.sha256;
  }
  const found = await readPlanFile(opts.plansDir, dep.id);
  return Boolean(found && found.sha256 === dep.sha256);
}

/** True when a header object is explicitly marked archived. */
function headerIsArchived(header: { isArchived?: unknown } | null): boolean {
  return Boolean(header && header.isArchived === true);
}

/** True when `list` contains this composer id as a string or `{ composerId }`. */
function listHasComposer(list: unknown, composerId: string): boolean {
  if (!Array.isArray(list)) return false;
  for (const item of list) {
    if (item === composerId) return true;
    if (
      item &&
      typeof item === 'object' &&
      (item as { composerId?: unknown }).composerId === composerId
    ) {
      return true;
    }
  }
  return false;
}

/** True when a list entry for this composer is marked archived. */
function listHasArchived(list: unknown, composerId: string): boolean {
  if (!Array.isArray(list)) return false;
  for (const item of list) {
    if (
      item &&
      typeof item === 'object' &&
      (item as { composerId?: unknown }).composerId === composerId &&
      headerIsArchived(item as { isArchived?: unknown })
    ) {
      return true;
    }
  }
  return false;
}

/** Parse workspace or header ItemTable JSON; invalid JSON is treated as empty. */
function parseItemRecord(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Present versus absent for a boolean binding check. */
function presence(value: boolean): TargetFacts['body'] {
  return value ? 'present' : 'absent';
}

/** True if the workspace ItemTable still lists this composer id. */
export async function composerMentioned(
  composerId: string,
  opts: {
    /** Open workspace database connection. */
    connWs: SqliteConn;
    /** Detected workspace schema. */
    wsInfo: Layout;
  },
): Promise<boolean> {
  if (!opts.wsInfo.itemTable) return false;
  const rec = parseItemRecord(
    await db.readItemText(opts.connWs, 'composer.composerData'),
  );
  if (!rec) return false;
  return (
    listHasComposer(rec.selectedComposerIds, composerId) ||
    listHasComposer(rec.lastFocusedComposerIds, composerId) ||
    listHasComposer(rec.allComposers, composerId)
  );
}

/**
 * Read-only observation of one previously imported composer. Global header
 * union is recorded as a leftover, not as a workspace-visible binding.
 */
export async function observeTargetComposer(opts: {
  /** Destination composer id whose rows are inspected. */
  targetComposerId: string;
  /** Destination workspace; kept so callers share the probe argument shape. */
  workspace: WorkspaceEntry;
  /** Open workspace database connection. */
  connWs: SqliteConn;
  /** Open global database connection. */
  connGl: SqliteConn;
  /** Detected workspace schema. */
  wsInfo: Layout;
  /** Detected global schema. */
  glInfo: Layout;
}): Promise<TargetFacts & { targetComposerId: string }> {
  const id = opts.targetComposerId;
  const body = await db.readKvText(opts.connGl, `composerData:${id}`);
  const bubbleIds = await db.listBubbleIds(opts.connGl, id);
  let workspaceList = false;
  let workspaceSelected = false;
  let archived = false;
  if (opts.wsInfo.itemTable) {
    const rec = parseItemRecord(
      await db.readItemText(opts.connWs, 'composer.composerData'),
    );
    if (rec) {
      workspaceList = listHasComposer(rec.allComposers, id);
      workspaceSelected =
        listHasComposer(rec.selectedComposerIds, id) ||
        listHasComposer(rec.lastFocusedComposerIds, id);
      archived = listHasArchived(rec.allComposers, id);
    }
  }
  let workspaceHeaders = false;
  if (opts.wsInfo.composerHeaders) {
    const rows = await db.readComposerHeadersTable(
      opts.connWs,
      opts.wsInfo.headerColumns,
    );
    const match = rows.filter((header) => header.composerId === id);
    workspaceHeaders = match.length > 0;
    archived = archived || match.some(headerIsArchived);
  }
  let globalHeader = false;
  if (opts.glInfo.itemTable) {
    const blob = await db.readItemJson(opts.connGl, 'composer.composerHeaders');
    globalHeader = listHasComposer(blob?.allComposers, id);
    archived = archived || listHasArchived(blob?.allComposers, id);
  }
  let globalHeadersTable = false;
  if (opts.glInfo.composerHeaders) {
    const rows = await db.readComposerHeadersTable(
      opts.connGl,
      opts.glInfo.headerColumns,
    );
    const match = rows.filter((header) => header.composerId === id);
    globalHeadersTable = match.length > 0;
    archived = archived || match.some(headerIsArchived);
  }
  return {
    targetComposerId: id,
    body: presence(Boolean(body)),
    bubbles: bubbleIds.size,
    workspaceList: presence(workspaceList),
    workspaceHeaders: presence(workspaceHeaders),
    workspaceSelected: presence(workspaceSelected),
    globalHeader: presence(globalHeader),
    globalHeadersTable: presence(globalHeadersTable),
    archived: presence(archived),
  };
}

/** Probe whether a target composer is live, gone, detached, or damaged. */
export async function probeTargetComposer(opts: {
  /** Destination composer id whose rows are classified. */
  targetComposerId: string;
  /** Destination workspace; kept so callers share the observation argument shape. */
  workspace: WorkspaceEntry;
  /** Open workspace database connection. */
  connWs: SqliteConn;
  /** Open global database connection. */
  connGl: SqliteConn;
  /** Detected workspace schema. */
  wsInfo: Layout;
  /** Detected global schema. */
  glInfo: Layout;
}): Promise<TargetProbeState> {
  return classifyTargetObservation(await observeTargetComposer(opts));
}

/** Compact facts for the operation log, including the classified verdict. */
export function formatTargetObservation(
  observation: TargetFacts & { targetComposerId: string },
): string {
  return formatTargetFacts(observation.targetComposerId, observation);
}
