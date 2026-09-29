import { createHash } from 'node:crypto';
import {
  blobKeysFromComposerBody,
  imageUuidsFromBubbles,
} from './dependencies';
import { planFilenamesFromChat } from './plans';
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
    /** Resource class. */
    kind: 'kv' | 'image' | 'plan';
    /** Key, image UUID, or plan basename. */
    id: string;
    /** SQLite storage class when this is a kv value. */
    storageClass?: 'text' | 'blob';
    /** SHA-256 of the bytes, or null when the resource is missing. */
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
export function canonicalJson(value: unknown, depth = 0): string {
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
export function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** SHA-256 of the canonical snapshot JSON. */
function hash(value: unknown): string {
  return sha256Text(canonicalJson(value));
}

/** Lexicographic order for stable fingerprint assembly. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Reject duplicate bubble ids or dependency identities in one snapshot. */
function unique(values: string[]): void {
  if (new Set(values).size !== values.length) {
    throw new Error('Duplicate snapshot identity');
  }
}

/** Stable hash of one chat snapshot; workspace rebinding is excluded. */
export function snapshotFingerprint(input: SnapshotInput): string {
  unique(input.bubbles.map((b) => b.bubbleId));
  unique(input.dependencies.map((d) => JSON.stringify([d.kind, d.id])));
  const header = { ...input.header };
  delete header.workspaceIdentifier;
  return hash({
    algorithm: 'cct-snapshot-v1',
    sourceComposerId: input.sourceComposerId,
    header,
    body: input.body,
    bubbles: [...input.bubbles].sort((a, b) => compare(a.bubbleId, b.bubbleId)),
    dependencies: [...input.dependencies].sort((a, b) =>
      compare(JSON.stringify([a.kind, a.id]), JSON.stringify([b.kind, b.id])),
    ),
    quality: input.quality,
  });
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
  const imagesById = new Map(
    opts.resources.attachments.map((row) => [row.id.toLowerCase(), row]),
  );
  const dependencies: SnapshotInput['dependencies'] = [];
  const blobs = blobKeysFromComposerBody(opts.bodyText);
  if (blobs.status === 'ok') {
    for (const key of blobs.keys) {
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
    const resource = imagesById.get(uuid.toLowerCase());
    dependencies.push(
      resource
        ? {
            kind: 'image',
            id: uuid,
            sha256: resource.sha256,
            byteLength: resource.byteLength,
            extension: resource.extension,
          }
        : { kind: 'image', id: uuid, sha256: null },
    );
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
  /** Composer id on this target. */
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
  /** Whether a stored header for this id is marked archived. */
  archived: PresenceFlag;
}

/**
 * Classify a verified target from observed rows.
 *
 * `available` requires the body and a workspace list or workspace header-table
 * binding. A leftover global header alone is not a live copy. Leftover body or
 * bubbles without those workspace bindings are `detached`, so a later manual
 * import may create a new independent copy. A workspace binding without a body
 * remains `inconsistent` and stays blocked. An archived header that still has
 * a body is treated as available so a hidden chat is not duplicated; an
 * archived header whose conversation rows are gone is detached and may be
 * restored.
 */
export function classifyTargetObservation(
  facts: TargetFacts,
): TargetProbeState {
  const bound =
    facts.workspaceList === 'present' || facts.workspaceHeaders === 'present';
  if (bound && facts.body === 'present') return 'available';
  if (bound) return 'inconsistent';
  const leftover =
    facts.body === 'present' ||
    facts.bubbles > 0 ||
    facts.workspaceSelected === 'present' ||
    facts.globalHeader === 'present' ||
    facts.globalHeadersTable === 'present';
  if (!leftover) return 'deleted';
  if (facts.archived === 'present' && facts.body === 'present') {
    return 'available';
  }
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
    `archived=${facts.archived}`,
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
