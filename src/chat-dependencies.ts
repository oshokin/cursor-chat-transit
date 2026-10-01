import { IMAGE_UUID } from './attachments';
import { openBlobGraph } from './blob-graph';
import { resourceError as fail } from './resource-bytes';
import type { BubbleRecord, DependencyAssessment } from './types';

/**
 * Composer `_v` values whose `conversationState` is the walked `~` protobuf.
 * 13 through 18 were compared on a live Cursor database: same encoding and
 * the same field numbers. 10 has no state. 11 uses a different encoding.
 */
export const MIN_WALKED_COMPOSER_VERSION = 13;

/** Newest composer `_v` checked against that walker. */
export const SUPPORTED_COMPOSER_VERSION = 18;

/** `agentKv:blob:` plus a 64-character lowercase hex digest. */
export const BLOB_KEY = /^agentKv:blob:[0-9a-f]{64}$/;

/** True when a KV key is an `agentKv:blob` address. */
export function isBlobKey(key: string): boolean {
  return BLOB_KEY.test(key);
}

/**
 * State-level `agentKv:blob:*` keys for one composer body.
 * Turns, todos, summaries, plans, and file-state ids are included.
 * Nested ids inside those blobs are not: callers that have the bytes use
 * `readBlobGraph` / `resolveBlobGraph`.
 * `_v` outside 13–18, and wire encodings this walker cannot read, return unsupported instead of an empty list.
 */
export function blobKeysFromComposerBody(bodyText: string): {
  /** `unsupported` when the composer body is not readable `_v` 18 state. */
  status: 'ok' | 'unsupported';
  /** State-level blob keys. Empty when status is unsupported. */
  keys: string[];
} {
  let body: unknown;

  try {
    body = JSON.parse(bodyText);
  } catch {
    return { status: 'unsupported', keys: [] };
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { status: 'unsupported', keys: [] };
  }

  const rec = body as Record<string, unknown>;
  const version = rec._v;
  const state = rec.conversationState;

  if (state === undefined || state === null) return { status: 'ok', keys: [] };

  if (
    version !== undefined &&
    (typeof version !== 'number' ||
      !Number.isInteger(version) ||
      version < MIN_WALKED_COMPOSER_VERSION ||
      version > SUPPORTED_COMPOSER_VERSION)
  ) {
    return { status: 'unsupported', keys: [] };
  }

  const graph = openBlobGraph(state);

  if (graph.status !== 'ok') return { status: 'unsupported', keys: [] };
  const keys = graph.seeds().filter((key) => isBlobKey(key));

  return { status: 'ok', keys };
}

/** Image UUIDs referenced by `images[].uuid` on bubble bodies. */
export function imageUuidsFromBubbles(
  list: BubbleRecord[] | undefined,
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();

  for (const bubble of list || []) {
    let parsed: unknown;

    try {
      parsed = JSON.parse(bubble.value);
    } catch {
      fail('UNSUPPORTED_BODY', 'Cannot remap bubble: unsupported payload.');
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      continue;
    const images = (parsed as Record<string, unknown>).images;

    if (images === undefined || images === null) continue;

    if (!Array.isArray(images)) {
      fail('UNSUPPORTED_BODY', 'Bubble images must be an array.');
    }

    for (const item of images) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const uuid = (item as Record<string, unknown>).uuid;

      if (typeof uuid !== 'string') continue;

      if (!IMAGE_UUID.test(uuid)) {
        fail('INVALID_RESOURCE', 'Invalid attachment id.');
      }

      const id = uuid.toLowerCase();

      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(uuid);
    }
  }

  return ids;
}

/** Union required blob keys from composer bodies; fail closed on unknown state. */
export function requiredBlobKeys(composers: Record<string, string>): {
  /** `unsupported` when any composer body cannot be read. */
  status: 'ok' | 'unsupported';
  /** Union of state-level blob keys. Empty when status is unsupported. */
  keys: string[];
} {
  const keys: string[] = [];
  const seen = new Set<string>();

  for (const body of Object.values(composers)) {
    const found = blobKeysFromComposerBody(body);

    if (found.status === 'unsupported') {
      return { status: 'unsupported', keys: [] };
    }

    for (const key of found.keys) {
      if (seen.has(key)) continue;
      seen.add(key);
      keys.push(key);
    }
  }

  return { status: 'ok', keys };
}

/** User-facing incomplete-resource copy. Counts only when they were measured. */
export function missingDependencyMessage(
  assessment: DependencyAssessment,
): string {
  const missing =
    assessment.missingKeys.length +
    assessment.missingAttachments.length +
    assessment.missingPlans.length +
    assessment.missingCanvases.length;

  const counted = missing > 0 ? ` Missing items measured: ${missing}.` : '';

  return (
    'The file is missing data needed to continue this chat. ' +
    'Export it again from the original Cursor with the updated extension.' +
    counted
  );
}
