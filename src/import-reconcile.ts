import path from 'node:path';
import { attachmentDirectory, isAttachmentBasename } from './attachments';
import { readCanvasFile } from './canvases';
import * as db from './db';
import { workspaceBinding } from './db-headers';
import { resolveAttachmentPath } from './dependencies';
import {
  classifyTargetObservation,
  formatTargetFacts,
  type TargetFacts,
  type TargetProbeState,
} from './import-policy';
import type { PendingImportChat } from './journal';
import { readPlanFile } from './plans';
import { hashFile } from './hash-file';
import { sha256Hex } from './resource-bytes';
import type { Layout, SqliteConn, WorkspaceEntry } from './types';
import { TransferError } from './types';
import { ERROR_DETAIL_CHARS } from './log-format';

/** Fail closed so a half-finished import is never treated as a new copy. */
export function needsAttention(
  /** Text written to the operation log. */
  message: string,
  /** Second line of a notice. */
  detail?: string,
): TransferError {
  const err = new TransferError(message);

  err.code = 'NEEDS_ATTENTION';

  if (detail) {
    err.detail = detail.replace(/[\r\n\t]/g, ' ').slice(0, ERROR_DETAIL_CHARS);
  }

  return err;
}

/**
 * Hash one image.
 * A missing file is not a match. Cancellation and permission errors propagate.
 */
async function imageChecksum(
  filePath: string,
  expected: string,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    signal?.throwIfAborted();
    const hashed = await hashFile(filePath, signal);

    return hashed.sha256 === expected;
  } catch (error) {
    if (signal?.aborted) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;

    throw error;
  }
}

/** True when the stored kv, image, or plan bytes match the pending checksum. */
export async function pendingResourceMatches(
  dep: NonNullable<PendingImportChat['expectedResources']>[number],
  opts: {
    /** Destination workspace used to resolve attachment files. */
    workspace: WorkspaceEntry;
    connGl: SqliteConn;
    /** Directory that should still hold pending plan files. */
    plansDir: string;
    /** Directory that should still hold pending canvas files. */
    canvasesDir: string | null;
    /** Stops an image checksum. Cancellation is not a mismatch. */
    signal?: AbortSignal;
  },
): Promise<boolean> {
  if (dep.kind === 'kv') {
    const stored = await db.readKvBytes(opts.connGl, dep.id);

    return Boolean(stored && sha256Hex(stored.bytes) === dep.sha256);
  }

  if (dep.kind === 'image') {
    if (isAttachmentBasename(dep.id)) {
      const dest = path.join(attachmentDirectory(opts.workspace), dep.id);

      return imageChecksum(dest, dep.sha256, opts.signal);
    }

    opts.signal?.throwIfAborted();

    const found = await resolveAttachmentPath(
      opts.workspace,
      dep.id,
      opts.signal,
    );

    if (!found) return false;

    return imageChecksum(found.filePath, dep.sha256, opts.signal);
  }

  if (dep.kind === 'plan') {
    const found = await readPlanFile(opts.plansDir, dep.id);

    return Boolean(found && found.sha256 === dep.sha256);
  }

  if (dep.kind === 'canvas') {
    if (!opts.canvasesDir) return false;
    const found = await readCanvasFile(opts.canvasesDir, dep.id);

    return Boolean(found && found.sha256 === dep.sha256);
  }

  return false;
}

/** True when a header object is explicitly marked archived. */
function headerIsArchived(
  header: {
    /** Archived flag stored on the composer, when present. */
    isArchived?: unknown;
  } | null,
): boolean {
  return Boolean(header && header.isArchived === true);
}

/** Explicit JSON archive flag when the header states one; otherwise undefined. */
function explicitArchive(
  headers: Array<{
    /** Archived flag stored on the composer, when present. */
    isArchived?: unknown;
  }>,
): boolean | undefined {
  let seen = false;
  let value = false;

  for (const header of headers) {
    if (header.isArchived === true || header.isArchived === false) {
      seen = true;
      value = header.isArchived === true;
    }
  }

  return seen ? value : undefined;
}

/** True when `list` contains this composer id as a string or `{ composerId }`. */
function listHasComposer(
  /** Bubble records to scan. */
  list: unknown,
  composerId: string,
): boolean {
  if (!Array.isArray(list)) return false;

  for (const item of list) {
    if (item === composerId) return true;

    if (
      item &&
      typeof item === 'object' &&
      (
        item as {
          /** Composer id when the value has one. */
          composerId?: unknown;
        }
      ).composerId === composerId
    ) {
      return true;
    }
  }

  return false;
}

/** True when a list entry for this composer is marked archived. */
function listHasArchived(
  /** Bubble records to scan. */
  list: unknown,
  composerId: string,
): boolean {
  if (!Array.isArray(list)) return false;

  for (const item of list) {
    if (
      item &&
      typeof item === 'object' &&
      (
        item as {
          /** Composer id when the value has one. */
          composerId?: unknown;
        }
      ).composerId === composerId &&
      /** Is archived. */
      headerIsArchived(
        item as {
          /** Archived flag stored on the composer, when present. */
          isArchived?: unknown;
        },
      )
    ) {
      return true;
    }
  }

  return false;
}

/** Parsed ItemTable JSON, or a distinct absent versus damaged result. */
type ItemRead =
  | {
      /** The metadata key is not stored. */
      status: 'absent';
    }
  | {
      /** The stored value is empty, NULL, or not a supported object. */
      status: 'invalid';
      /** Bounded reason for the operation log. */
      detail: string;
    }
  | {
      /** The stored value is a JSON object. */
      status: 'ok';
      /** That object. List fields are checked separately. */
      record: Record<string, unknown>;
    };

/** Fields replaced when a workspace chat list is updated. */
const WORKSPACE_LIST_FIELDS = [
  'allComposers',
  'selectedComposerIds',
  'lastFocusedComposerIds',
] as const;

/** Field replaced when the global header blob is updated. */
const GLOBAL_LIST_FIELDS = ['allComposers'] as const;

/** True when one allComposers entry is an id string or a header object. */
function isHeaderEntry(item: unknown): boolean {
  if (typeof item === 'string') return item.length > 0;

  return (
    !!item &&
    typeof item === 'object' &&
    !Array.isArray(item) &&
    typeof (
      item as {
        /** Composer id when the value has one. */
        composerId?: unknown;
      }
    ).composerId === 'string' &&
    (
      item as {
        composerId: string;
      }
    ).composerId.length > 0
  );
}

/**
 * Refuse a present list field whose shape this import would read or replace.
 * A missing field is allowed. Unknown sibling fields are left untouched.
 */
function unsupportedListField(
  record: Record<string, unknown>,
  key: string,
  field: (typeof WORKSPACE_LIST_FIELDS)[number],
): string | null {
  if (!Object.prototype.hasOwnProperty.call(record, field)) return null;

  const value = record[field];
  const headerList = field === 'allComposers';

  if (!Array.isArray(value)) {
    return `unsupported-field key=${key} field=${field}`;
  }

  for (const item of value) {
    const ok = headerList
      ? isHeaderEntry(item)
      : typeof item === 'string' && item.length > 0;

    if (!ok) return `unsupported-field key=${key} field=${field}`;
  }

  return null;
}

/** Read one metadata cell without treating an empty or NULL value as absence. */
async function readItemRecord(
  conn: SqliteConn,
  key: string,
): Promise<ItemRead> {
  const state = await db.readItemTextState(conn, key);

  if (state.status === 'absent') return { status: 'absent' };

  if (state.status === 'empty') {
    return { status: 'invalid', detail: `empty-value key=${key}` };
  }

  if (state.status === 'null') {
    return { status: 'invalid', detail: `sql-null key=${key}` };
  }

  if (state.status === 'unsupported') {
    return {
      status: 'invalid',
      detail: `unsupported-value key=${key} class=${state.storageClass}`,
    };
  }

  try {
    const parsed: unknown = JSON.parse(state.text);

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { status: 'invalid', detail: `invalid-json key=${key}` };
    }

    return { status: 'ok', record: parsed as Record<string, unknown> };
  } catch {
    return { status: 'invalid', detail: `invalid-json key=${key}` };
  }
}

/**
 * Refuse an import before any composer write when stored list metadata is
 * missing as a value, unreadable, or not a supported list shape. A missing
 * key and missing optional fields are allowed.
 */
export async function assertStoredListsReadable(opts: {
  connWs: SqliteConn;
  connGl: SqliteConn;
  /** Detected workspace schema. */
  wsInfo: Layout;
  /** Detected global schema. */
  glInfo: Layout;
}): Promise<void> {
  const checks: Array<
    [
      boolean,
      SqliteConn,
      string,
      readonly (typeof WORKSPACE_LIST_FIELDS)[number][],
    ]
  > = [
    [
      opts.wsInfo.itemTable,
      opts.connWs,
      'composer.composerData',
      WORKSPACE_LIST_FIELDS,
    ],
    [
      opts.glInfo.itemTable,
      opts.connGl,
      'composer.composerHeaders',
      GLOBAL_LIST_FIELDS,
    ],
  ];

  for (const [present, conn, key, fields] of checks) {
    if (!present) continue;
    const read = await readItemRecord(conn, key);

    if (read.status === 'invalid') {
      throw needsAttention(
        'Stored chat metadata is unreadable. No new copies were created.',
        read.detail,
      );
    }

    if (read.status !== 'ok') continue;

    for (const field of fields) {
      const detail = unsupportedListField(read.record, key, field);

      if (detail) {
        throw needsAttention(
          'Stored chat metadata has an unsupported shape. No new copies were created.',
          detail,
        );
      }
    }
  }
}

/** Whether a composer body is absent, a JSON object, or damaged. */
function assessBody(
  raw: string | null,
  /** Old bubble id to the new bubble id. */
  bubbleIds: ReadonlySet<string>,
): {
  /** Absent, a JSON object, or damaged. */
  shape: 'absent' | 'valid' | 'invalid';
  /** Whether every referenced bubble id is present. */
  references: 'satisfied' | 'missing';
} {
  if (!raw) return { shape: 'absent', references: 'satisfied' };
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return { shape: 'invalid', references: 'satisfied' };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { shape: 'invalid', references: 'satisfied' };
  }

  /** Full conversation headers only. */
  const headers = (
    parsed as {
      /** Ordered message headers on the composer. */
      fullConversationHeadersOnly?: unknown;
    }
  ).fullConversationHeadersOnly;

  if (headers === undefined) return { shape: 'valid', references: 'satisfied' };

  if (!Array.isArray(headers)) {
    return { shape: 'invalid', references: 'satisfied' };
  }

  for (const item of headers) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { shape: 'invalid', references: 'satisfied' };
    }

    const bubbleId = (
      item as {
        bubbleId?: unknown;
      }
    ).bubbleId;

    if (typeof bubbleId !== 'string' || !bubbleId) {
      return { shape: 'invalid', references: 'satisfied' };
    }

    if (!bubbleIds.has(bubbleId)) {
      return { shape: 'valid', references: 'missing' };
    }
  }

  return { shape: 'valid', references: 'satisfied' };
}

/** Combine a JSON archive flag with the SQL `isArchived` column. */
function mergeArchive(
  jsonArchived: boolean,
  jsonExplicit: boolean | undefined,
  column: Awaited<ReturnType<typeof db.composerHeaderArchiveColumn>>,
): {
  archived: boolean;
  /** The column and the JSON flag disagree. */
  conflict: boolean;
} {
  if (column === 'invalid') return { archived: jsonArchived, conflict: true };

  if (column === 'archived' && jsonExplicit === false) {
    return { archived: true, conflict: true };
  }

  if (column === 'active' && jsonExplicit === true) {
    return { archived: true, conflict: true };
  }

  return {
    archived: jsonArchived || column === 'archived',
    conflict: false,
  };
}

/** Present versus absent for a boolean binding check. */
function presence(value: boolean): TargetFacts['body'] {
  return value ? 'present' : 'absent';
}

/** True if the workspace ItemTable still lists this composer id. */
export async function composerMentioned(
  composerId: string,
  opts: {
    connWs: SqliteConn;
    /** Detected workspace schema. */
    wsInfo: Layout;
  },
): Promise<boolean> {
  if (!opts.wsInfo.itemTable) return false;

  const read = await readItemRecord(opts.connWs, 'composer.composerData');

  if (read.status === 'invalid') {
    throw needsAttention(
      'Stored chat metadata is unreadable. No new copies were created.',
      read.detail,
    );
  }

  if (read.status !== 'ok') return false;

  for (const field of WORKSPACE_LIST_FIELDS) {
    const detail = unsupportedListField(
      read.record,
      'composer.composerData',
      field,
    );

    if (detail) {
      throw needsAttention(
        'Stored chat metadata has an unsupported shape. No new copies were created.',
        detail,
      );
    }
  }

  return (
    listHasComposer(read.record.selectedComposerIds, composerId) ||
    listHasComposer(read.record.lastFocusedComposerIds, composerId) ||
    listHasComposer(read.record.allComposers, composerId)
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
  connWs: SqliteConn;
  connGl: SqliteConn;
  /** Detected workspace schema. */
  wsInfo: Layout;
  /** Detected global schema. */
  glInfo: Layout;
}): Promise<
  TargetFacts & {
    targetComposerId: string;
  }
> {
  const id = opts.targetComposerId;
  const body = await db.readKvText(opts.connGl, `composerData:${id}`);
  const bubbleIds = await db.listBubbleIds(opts.connGl, id);
  const assessed = assessBody(body, bubbleIds);
  let workspaceList = false;
  let workspaceSelected = false;
  let archived = false;
  let metadataInvalid = false;

  if (opts.wsInfo.itemTable) {
    const read = await readItemRecord(opts.connWs, 'composer.composerData');

    if (read.status === 'invalid') metadataInvalid = true;

    if (read.status === 'ok') {
      metadataInvalid =
        metadataInvalid ||
        WORKSPACE_LIST_FIELDS.some((field) =>
          unsupportedListField(read.record, 'composer.composerData', field),
        );

      workspaceList = listHasComposer(read.record.allComposers, id);

      workspaceSelected =
        listHasComposer(read.record.selectedComposerIds, id) ||
        listHasComposer(read.record.lastFocusedComposerIds, id);

      archived = listHasArchived(read.record.allComposers, id);
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

    const column = await db.composerHeaderArchiveColumn(
      opts.connWs,
      opts.wsInfo.headerColumns,
      id,
    );

    const merged = mergeArchive(
      match.some(headerIsArchived),
      explicitArchive(match),
      column,
    );

    archived = archived || merged.archived;
    metadataInvalid = metadataInvalid || merged.conflict;
  }

  let globalHeader = false;

  if (opts.glInfo.itemTable) {
    const read = await readItemRecord(opts.connGl, 'composer.composerHeaders');

    if (read.status === 'invalid') metadataInvalid = true;

    if (read.status === 'ok') {
      metadataInvalid =
        metadataInvalid ||
        GLOBAL_LIST_FIELDS.some((field) =>
          unsupportedListField(read.record, 'composer.composerHeaders', field),
        );

      globalHeader = listHasComposer(read.record.allComposers, id);
      archived = archived || listHasArchived(read.record.allComposers, id);
    }
  }

  let globalHeadersTable = false;
  let globalWorkspaceBinding: TargetFacts['globalWorkspaceBinding'] = 'absent';

  if (opts.glInfo.composerHeaders) {
    const rows = await db.readComposerHeadersTable(
      opts.connGl,
      opts.glInfo.headerColumns,
    );

    const match = rows.filter((header) => header.composerId === id);

    globalHeadersTable = match.length > 0;

    const columnWorkspaceId = await db.composerHeaderWorkspaceColumn(
      opts.connGl,
      opts.glInfo.headerColumns,
      id,
    );

    if (match.length) {
      const header = match[0];
      const jsonId = header?.workspaceIdentifier?.id;

      const columnDisagrees =
        !!columnWorkspaceId && !!jsonId && columnWorkspaceId !== jsonId;

      const binding = columnDisagrees
        ? 'conflict'
        : header
          ? workspaceBinding(
              header,
              opts.workspace.storageId,
              opts.workspace.identity,
            )
          : 'unbound';

      if (binding === 'conflict') globalWorkspaceBinding = 'conflict';
      else if (binding === 'match') globalWorkspaceBinding = 'present';
    }

    const column = await db.composerHeaderArchiveColumn(
      opts.connGl,
      opts.glInfo.headerColumns,
      id,
    );

    const merged = mergeArchive(
      match.some(headerIsArchived),
      explicitArchive(match),
      column,
    );

    archived = archived || merged.archived;
    metadataInvalid = metadataInvalid || merged.conflict;
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
    globalWorkspaceBinding,
    archived: presence(archived),
    bodyShape: assessed.shape,
    references: assessed.references,
    metadata: metadataInvalid ? 'invalid' : 'ok',
  };
}

/** Probe whether a target composer is live, gone, detached, or damaged. */
export async function probeTargetComposer(opts: {
  /** Destination composer id whose rows are classified. */
  targetComposerId: string;
  /** Destination workspace; kept so callers share the observation argument shape. */
  workspace: WorkspaceEntry;
  connWs: SqliteConn;
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
  observation: TargetFacts & {
    targetComposerId: string;
  },
): string {
  return formatTargetFacts(observation.targetComposerId, observation);
}
