import { createHash } from 'node:crypto';
import {
  blobKeysFromComposerBody,
  decodeSqliteBytes,
  imageUuidsFromBubbles,
  resolveBlobGraph,
} from './dependencies';
import { canvasFilenamesFromChat } from './canvases';
import { planFilenamesFromChat } from './plans';
import { SnapshotHasher } from './snapshot-hash';
import type { BubbleRecord, ComposerHeader, ExportResources } from './types';

/** One bubble's identity and JSON body, used when hashing a snapshot. */
export interface SnapshotBubble {
  /** Bubble id from the export, not a regenerated destination id. */
  bubbleId: string;
  /** Parsed bubble JSON included in the fingerprint. */
  payload: Record<string, unknown>;
}

/** Canonical chat facts hashed for repeat-import identity. */
export interface SnapshotInput {
  /** Composer id in the source snapshot. */
  sourceComposerId: string;
  /** Header fields included in the fingerprint. */
  header: Record<string, unknown>;
  /** Composer body fields included in the fingerprint. */
  body: Record<string, unknown>;
  /** Bubble payloads included in the fingerprint. */
  bubbles: SnapshotBubble[];
  /** Reachable kv, image, and plan bytes. */
  dependencies: Array<{
    kind: 'kv' | 'image' | 'plan' | 'canvas';
    /** Key, image UUID, plan basename, or canvas basename. */
    id: string;
    /** SQLite storage class when this is a kv value. */
    storageClass?: 'text' | 'blob';
    sha256: string | null;
    /** Decoded byte length when known. */
    byteLength?: number;
    /** Image extension when this is an attachment. */
    extension?: string;
  }>;
  /** Completeness of this snapshot. */
  quality: 'complete' | 'history-only';
}

/** JSON semantics: object order ignored, array order preserved. Not RFC 8785. */
export function canonicalJson(
  /** JSON value to canonicalize. */
  value: unknown,
  /** Remaining recursion depth. */
  depth = 0,
): string {
  if (depth > 128) throw new Error('Snapshot nesting limit');
  if (value === null) return 'null';

  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return (
      '[' + value.map((item) => canonicalJson(item, depth + 1)).join(',') + ']'
    );
  }

  if (value && typeof value === 'object') {
    const rec = value as Record<string, unknown>;

    return (
      '{' +
      Object.keys(rec)
        .sort()
        .filter((key) => rec[key] !== undefined)
        .map(
          (key) =>
            JSON.stringify(key) + ':' + canonicalJson(rec[key], depth + 1),
        )
        .join(',') +
      '}'
    );
  }

  throw new Error('Expected finite JSON data');
}

/** SHA-256 of UTF-8 text as lowercase hex. */
export function sha256Text(
  /** Text whose SHA-256 is recorded. */
  value: string,
): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Lexicographic order for stable fingerprint assembly. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Separate the conversation array from the rest of a composer body. */
export function splitConversation(body: Record<string, unknown>): {
  /** Composer fields without the extracted conversation array. */
  fields: Record<string, unknown>;
  /** Whether the array was missing, empty, or populated. */
  state: 'absent' | 'empty' | 'present';
  /** Conversation elements in source order. */
  items: unknown[];
} {
  const fields = { ...body };
  const headers = fields.fullConversationHeadersOnly;

  delete fields.fullConversationHeadersOnly;

  if (headers === undefined) {
    return { fields, state: 'absent', items: [] };
  }

  if (!Array.isArray(headers)) throw new Error('Expected conversation array');
  if (!headers.length) return { fields, state: 'empty', items: [] };

  return { fields, state: 'present', items: headers };
}

/** Reject duplicate bubble ids or dependency identities in one snapshot. */
function unique(values: string[]): void {
  if (new Set(values).size !== values.length) {
    throw new Error('Duplicate snapshot identity');
  }
}

/**
 * Stable hash of one chat snapshot.
 * Workspace rebinding is excluded. Only `fullConversationHeadersOnly[*].grouping.textPreview`
 * is excluded. The stored chat is not modified.
 */
export function snapshotFingerprint(input: SnapshotInput): string {
  unique(input.bubbles.map((b) => b.bubbleId));

  unique(input.dependencies.map((d) => JSON.stringify([d.kind, d.id])));

  const split = splitConversation(input.body);
  const hasher = new SnapshotHasher();

  hasher.source(input.sourceComposerId);
  hasher.header(input.header);
  hasher.composer(split.fields);
  hasher.conversationState(split.state);

  for (const item of split.items) hasher.conversationItem(item);

  const bubbles = [...input.bubbles].sort((a, b) =>
    compare(a.bubbleId, b.bubbleId),
  );

  for (const bubble of bubbles) {
    hasher.bubbleDigest(
      SnapshotHasher.bubbleComponent(bubble.bubbleId, bubble.payload),
    );
  }

  const dependencies = [...input.dependencies].sort((a, b) =>
    compare(JSON.stringify([a.kind, a.id]), JSON.stringify([b.kind, b.id])),
  );

  for (const dependency of dependencies) hasher.dependency(dependency);
  hasher.quality(input.quality);

  return hasher.digest();
}

/** Build a fingerprint input from one already-validated export chat. */
export function snapshotInputFromChat(opts: {
  /** Source composer header from the export. */
  header: ComposerHeader;
  /** Composer body JSON text from the export. */
  bodyText: string;
  /** Bubble rows for this composer, if the export included any. */
  bubbles: BubbleRecord[] | undefined;
  /** Envelope resources used to complete the fingerprint. */
  resources: ExportResources;
  /** Whether this snapshot is complete or history-only. */
  quality: 'complete' | 'history-only';
}): SnapshotInput {
  const bodyParsed: unknown = JSON.parse(opts.bodyText);

  if (
    !bodyParsed ||
    typeof bodyParsed !== 'object' ||
    Array.isArray(bodyParsed)
  ) {
    throw new Error('Expected composer object');
  }

  const bubbles: SnapshotInput['bubbles'] = [];

  for (const row of opts.bubbles || []) {
    const parsed: unknown = JSON.parse(row.value);

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Expected bubble object');
    }

    bubbles.push({
      bubbleId: row.bubbleId,
      payload: parsed as Record<string, unknown>,
    });
  }

  const kvByKey = new Map(opts.resources.kv.map((row) => [row.key, row]));

  const imagesByUuid = new Map<string, typeof opts.resources.attachments>();

  for (const row of opts.resources.attachments) {
    const id = row.id.toLowerCase();
    const list = imagesByUuid.get(id) || [];

    list.push(row);
    imagesByUuid.set(id, list);
  }

  const dependencies: SnapshotInput['dependencies'] = [];
  const blobs = blobKeysFromComposerBody(opts.bodyText);

  if (blobs.status === 'ok') {
    const stored = new Map<string, Buffer>();

    for (const row of opts.resources.kv) {
      if (!row.key.startsWith('agentKv:blob:')) continue;

      stored.set(
        row.key.slice('agentKv:blob:'.length),
        decodeSqliteBytes(row.value),
      );
    }

    const closed = resolveBlobGraph(
      (bodyParsed as Record<string, unknown>).conversationState,
      stored,
    );

    const ids =
      closed.status === 'ok' ? [...closed.keys, ...closed.missing] : blobs.keys;

    for (const key of ids) {
      const resource = kvByKey.get(key);

      dependencies.push(
        resource
          ? {
              kind: 'kv',
              id: key,
              storageClass: resource.value.storageClass,
              sha256: resource.value.sha256,
              byteLength: resource.value.byteLength,
            }
          : { kind: 'kv', id: key, sha256: null },
      );
    }
  }

  for (const uuid of imageUuidsFromBubbles(opts.bubbles)) {
    const rows = imagesByUuid.get(uuid.toLowerCase()) || [];

    if (!rows.length) {
      dependencies.push({ kind: 'image', id: uuid, sha256: null });
      continue;
    }

    for (const resource of rows) {
      dependencies.push({
        kind: 'image',
        id: resource.filename || uuid,
        sha256: resource.sha256,
        byteLength: resource.byteLength,
        extension: resource.extension,
      });
    }
  }

  const plansByName = new Map(
    (opts.resources.plans || []).map((row) => [row.filename, row]),
  );

  for (const name of planFilenamesFromChat(opts.bodyText, opts.bubbles)) {
    const resource = plansByName.get(name);

    dependencies.push(
      resource
        ? {
            kind: 'plan',
            id: name,
            sha256: resource.sha256,
            byteLength: resource.byteLength,
          }
        : { kind: 'plan', id: name, sha256: null },
    );
  }

  const canvasesByName = new Map(
    (opts.resources.canvases || []).map((row) => [row.filename, row]),
  );

  for (const name of canvasFilenamesFromChat(opts.bodyText, opts.bubbles)) {
    const resource = canvasesByName.get(name);

    dependencies.push(
      resource
        ? {
            kind: 'canvas',
            id: name,
            sha256: resource.sha256,
            byteLength: resource.byteLength,
          }
        : { kind: 'canvas', id: name, sha256: null },
    );
  }

  return {
    sourceComposerId: opts.header.composerId,
    header: { ...opts.header },
    body: bodyParsed as Record<string, unknown>,
    bubbles,
    dependencies,
    quality: opts.quality,
  };
}

/** Journal row that records a completed or pending mapping into this target. */
export interface Receipt {
  /** Canonical destination workspace identity. */
  targetKey: string;
  /** Composer id in the export. */
  sourceComposerId: string;
  /** Canonical hash of that source snapshot. */
  snapshotHash: string;
  targetComposerId: string;
  /** Pending write versus verified mapping. */
  state: 'pending' | 'verified';
}

/** Skip an identical copy, create another, or refuse an inconsistent target. */
export type Decision =
  | {
      /** This snapshot is already present; do not write again. */
      action: 'skip';
      /** Destination composer that already holds the snapshot. */
      targetComposerId: string;
    }
  | {
      /** Write a new local copy. */
      action: 'create';
      /** Why a new copy is required. */
      reason: 'first-import' | 'different-snapshot' | 'deleted-copy';
    }
  | {
      /** Do not write; the target is unsafe for this snapshot. */
      action: 'blocked';
      /** Why the write must not proceed. */
      reason: 'pending-import' | 'inconsistent-target';
    };

/**
 * Read-only conclusion for one previously imported target composer.
 * `available` means the body and a workspace list or workspace header-table
 * binding still resolve. `deleted` means no leftover rows remain. `detached`
 * means leftover rows exist without that workspace binding. `inconsistent`
 * means a workspace binding remains but the body does not.
 */
export type TargetProbeState =
  'available' | 'deleted' | 'detached' | 'inconsistent';

/** Whether a named binding or body row is present in the target databases. */
export type PresenceFlag = 'present' | 'absent';

/**
 * Structured facts about one target composer. Policy classifies these; the
 * probe must not collapse leftover rows and a live workspace binding into one
 * `inconsistent` bit.
 */
export interface TargetFacts {
  /** Whether `composerData:<id>` exists. */
  body: PresenceFlag;
  /** Number of `bubbleId:<id>:*` rows for this composer. */
  bubbles: number;
  /** Whether workspace `ItemTable` `allComposers` includes this id. */
  workspaceList: PresenceFlag;
  /** Whether the workspace `composerHeaders` table includes this id. */
  workspaceHeaders: PresenceFlag;
  /** Whether selected or last-focused workspace ids include this composer. */
  workspaceSelected: PresenceFlag;
  /** Whether the global `composer.composerHeaders` blob lists this id. */
  globalHeader: PresenceFlag;
  /** Whether the global `composerHeaders` table has a row for this id. */
  globalHeadersTable: PresenceFlag;
  /**
   * Whether that global row proves membership in this workspace.
   * `conflict` means the stored workspace ids disagree or cannot be read.
   */
  globalWorkspaceBinding: 'present' | 'absent' | 'conflict';
  /** Whether a stored header for this id is marked archived. */
  archived: PresenceFlag;
  /** Whether the composer body parses as a JSON object. */
  bodyShape: 'absent' | 'valid' | 'invalid';
  /** Whether every bubble id named by the body is still stored. */
  references: 'satisfied' | 'missing';
  /** Whether list JSON and archive flags have a supported shape. */
  metadata: 'ok' | 'invalid';
}

/**
 * Classify a verified target from observed rows.
 *
 * `available` requires a well-formed body, every referenced bubble, and a
 * workspace list, a workspace header-table row, a global header row that
 * matches this workspace, or an archived header. A global row for another
 * workspace, or a legacy header with no workspace claim, is not membership.
 * A contradictory workspace claim is `inconsistent` and blocks the import.
 * Leftover intact rows without a membership proof are `detached`, so a later
 * manual import may create a new independent copy. A damaged body, a missing
 * referenced bubble, or unreadable list JSON stays blocked. An archived header
 * whose conversation rows are gone is detached and may be restored. An empty
 * conversation is intact: a chat is not required to contain a bubble.
 */
export function classifyTargetObservation(
  facts: TargetFacts,
): TargetProbeState {
  if (
    facts.metadata === 'invalid' ||
    facts.bodyShape === 'invalid' ||
    facts.references === 'missing' ||
    facts.globalWorkspaceBinding === 'conflict'
  ) {
    return 'inconsistent';
  }

  const intact = facts.bodyShape === 'valid';

  const bound =
    facts.workspaceList === 'present' ||
    facts.workspaceHeaders === 'present' ||
    facts.globalWorkspaceBinding === 'present';

  if (bound && intact) return 'available';

  if (
    facts.workspaceList === 'present' ||
    facts.workspaceHeaders === 'present'
  ) {
    return 'inconsistent';
  }

  const leftover =
    facts.body === 'present' ||
    facts.bubbles > 0 ||
    facts.workspaceSelected === 'present' ||
    facts.globalHeader === 'present' ||
    facts.globalHeadersTable === 'present';

  if (!leftover) return 'deleted';
  if (facts.archived === 'present' && intact) return 'available';

  return 'detached';
}

/** Compact operation-log facts for one target; never payloads or SQL. */
export function formatTargetFacts(
  targetComposerId: string,
  facts: TargetFacts,
): string {
  const verdict = classifyTargetObservation(facts);

  return [
    `target=${targetComposerId}`,
    `body=${facts.body}`,
    `bubbles=${facts.bubbles}`,
    `workspaceList=${facts.workspaceList}`,
    `workspaceSelected=${facts.workspaceSelected}`,
    `workspaceHeaders=${facts.workspaceHeaders}`,
    `globalHeader=${facts.globalHeader}`,
    `globalHeadersTable=${facts.globalHeadersTable}`,
    `globalWorkspaceBinding=${facts.globalWorkspaceBinding}`,
    `archived=${facts.archived}`,
    `bodyShape=${facts.bodyShape}`,
    `references=${facts.references}`,
    `metadata=${facts.metadata}`,
    `verdict=${verdict}`,
  ].join(' ');
}

/**
 * Probe is read-only. Scan every matching receipt: skip when any copy is
 * still workspace-visible; block only when a damaged bound copy exists and
 * none is available. Detached leftovers are restored as a new copy.
 *
 * @param input Snapshot identity for this destination.
 * @param receipts Journal mappings already recorded for any target.
 * @param probe Read-only classification of one previously imported destination composer.
 */
export async function decideImport(
  input: Pick<Receipt, 'targetKey' | 'sourceComposerId' | 'snapshotHash'>,
  receipts: readonly Receipt[],
  probe: (targetComposerId: string) => Promise<TargetProbeState>,
): Promise<Decision> {
  const targetReceipts = receipts.filter(
    (r) => r.targetKey === input.targetKey,
  );

  if (targetReceipts.some((r) => r.state === 'pending')) {
    return { action: 'blocked', reason: 'pending-import' };
  }

  const sourceReceipts = targetReceipts.filter(
    (r) => r.sourceComposerId === input.sourceComposerId,
  );

  const same = sourceReceipts.filter(
    (r) => r.snapshotHash === input.snapshotHash,
  );

  let availableId: string | undefined;
  let sawInconsistent = false;

  for (const receipt of same) {
    const state = await probe(receipt.targetComposerId);

    if (state === 'available' && availableId === undefined) {
      availableId = receipt.targetComposerId;
    }

    if (state === 'inconsistent') sawInconsistent = true;
  }

  if (availableId) {
    return { action: 'skip', targetComposerId: availableId };
  }

  if (sawInconsistent) {
    return { action: 'blocked', reason: 'inconsistent-target' };
  }

  return {
    action: 'create',
    reason: same.length
      ? 'deleted-copy'
      : sourceReceipts.length
        ? 'different-snapshot'
        : 'first-import',
  };
}
