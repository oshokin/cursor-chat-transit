import { decodeState, readFields, type WireField } from './conversation-state';

/**
 * Blob roles taken from Cursor's `agent.v1` descriptors
 * (`ConversationStateStructure`, `ConversationTurnStructure`,
 * `AgentConversationTurnStructure`, `UserMessage`, `ConversationSummaryArchive`,
 * `FileStateStructure`). A 32-byte length-delimited value in one of these
 * fields is an `agentKv:blob` id. Other 32-byte values are followed only when
 * that id is already stored.
 */

/** How a blob id should be parsed once its bytes are loaded. */
type Kind = 'state' | 'turn' | 'user-message' | 'summary-archive' | 'scan';

/** One id discovered while walking a chat. */
interface Node {
  /** Lowercase hex digest. */
  digest: string;
  /** Parser to apply to the blob bytes. */
  kind: Kind;
  /** Absence makes the chat incomplete. */
  required: boolean;
}

/** State fields whose 32-byte payloads are blob ids. */
const STATE_BLOB_KIND: Record<number, Kind> = {
  1: 'scan',
  3: 'scan',
  6: 'scan',
  7: 'scan',
  8: 'turn',
  11: 'summary-archive',
  13: 'summary-archive',
};

/** Stop a runaway graph. Real chats stay well under this. */
const MAX_NODES = 100_000;

/** `agentKv:blob:` plus a digest. */
function blobKey(digest: string): string {
  return `agentKv:blob:${digest}`;
}

/** 32-byte blob id, or null when the field is inline content. */
function digestOf(bytes: Buffer): string | null {
  return bytes.length === 32 ? bytes.toString('hex') : null;
}

/** Top-level fields, or null when the buffer is not a complete protobuf. */
function tryFields(bytes: Buffer): WireField[] | null {
  try {
    return [...readFields(bytes)];
  } catch {
    return null;
  }
}

/** Field 2 of a protobuf map entry. */
function mapValue(entry: Buffer): Buffer | null {
  const fields = tryFields(entry);

  if (!fields) throw new Error('Bad map entry');
  const value = fields.find((field) => field.field === 2 && field.wire === 2);

  return value ? value.bytes : null;
}

/**
 * Blob ids named by one `ConversationStateStructure`.
 * Malformed wire data throws so the caller can fail closed.
 */
function refsFromState(bytes: Buffer, depth = 0): Node[] {
  if (depth > 4) throw new Error('Nested conversation state is too deep.');
  const out: Node[] = [];

  for (const field of readFields(bytes)) {
    if (field.wire !== 2) continue;
    const kind = STATE_BLOB_KIND[field.field];
    const digest = digestOf(field.bytes);

    if (kind && digest) out.push({ digest, kind, required: true });
    if (field.field === 12 || field.field === 31) pushMapBlob(field.bytes, out);
    if (field.field === 15) pushFileState(field.bytes, out);

    if (field.field === 16) {
      const nested = mapValue(field.bytes);

      if (!nested) continue;

      const state = tryFields(nested)?.find(
        (row) => row.field === 1 && row.wire === 2,
      );

      if (!state) continue;
      out.push(...refsFromState(state.bytes, depth + 1));
    }
  }

  return out;
}

/** `file_states` / `subagent_state_refs`: the map value is the blob id. */
function pushMapBlob(entry: Buffer, out: Node[]): void {
  const value = mapValue(entry);
  const digest = value ? digestOf(value) : null;

  if (digest) out.push({ digest, kind: 'scan', required: true });
}

/** `file_states_v2`: content and initial_content are blob ids. */
function pushFileState(entry: Buffer, out: Node[]): void {
  const value = mapValue(entry);

  if (!value) return;
  const inner = tryFields(value);

  if (!inner) throw new Error('Bad file state');

  for (const field of inner) {
    if (field.wire !== 2 || (field.field !== 1 && field.field !== 2)) continue;
    const digest = digestOf(field.bytes);

    if (digest) out.push({ digest, kind: 'scan', required: true });
  }
}

/** Blob ids a loaded record requires. Unknown bytes contribute nothing. */
function schemaRefs(kind: Kind, bytes: Buffer): Node[] {
  if (kind === 'state') return refsFromState(bytes);
  if (kind === 'turn') return turnRefs(bytes);
  if (kind === 'user-message') return userMessageRefs(bytes);
  if (kind === 'summary-archive') return summaryRefs(bytes);

  return [];
}

/** `user_message`, `steps`, `shell_command`, and `shell_output`. */
function turnRefs(bytes: Buffer): Node[] {
  const top = tryFields(bytes);

  if (!top) throw new Error('Malformed conversation turn.');
  const out: Node[] = [];

  for (const field of top) {
    if (field.wire !== 2 || (field.field !== 1 && field.field !== 2)) continue;
    const inner = tryFields(field.bytes);

    if (!inner) throw new Error('Malformed nested conversation turn.');

    for (const row of inner) {
      if (row.wire !== 2 || (row.field !== 1 && row.field !== 2)) continue;
      const digest = digestOf(row.bytes);

      if (!digest) continue;
      const userMessage = field.field === 1 && row.field === 1;

      out.push({
        digest,
        kind: userMessage ? 'user-message' : 'scan',
        required: true,
      });
    }
  }

  return out;
}

/** `conversation_state_blob_id`, `text_blob_id`, and `rich_text_blob_id`. */
function userMessageRefs(bytes: Buffer): Node[] {
  const fields = tryFields(bytes);

  if (!fields) throw new Error('Malformed structured blob.');
  const out: Node[] = [];

  for (const field of fields) {
    if (field.wire !== 2) continue;
    const digest = digestOf(field.bytes);

    if (!digest) continue;

    if (field.field === 10) {
      out.push({ digest, kind: 'state', required: true });
    } else if (field.field === 18 || field.field === 19) {
      out.push({ digest, kind: 'scan', required: true });
    }
  }

  return out;
}

/** `summarized_messages` and `summary_message`. */
function summaryRefs(bytes: Buffer): Node[] {
  const fields = tryFields(bytes);

  if (!fields) throw new Error('Malformed structured blob.');
  const out: Node[] = [];

  for (const field of fields) {
    if (field.wire !== 2 || (field.field !== 1 && field.field !== 4)) continue;
    const digest = digestOf(field.bytes);

    if (digest) out.push({ digest, kind: 'scan', required: true });
  }

  return out;
}

/**
 * Every 32-byte length-delimited field in a blob that parses as protobuf.
 * Callers must not treat a miss as incomplete: strings and hashes also fit.
 */
function looseDigests(bytes: Buffer): string[] {
  const out: string[] = [];

  /** Nested length-delimited fields. A 32-byte payload is recorded and not opened. */
  const walk = (buf: Buffer, depth: number): void => {
    if (depth > 32) return;
    const fields = tryFields(buf);

    if (!fields) return;

    for (const field of fields) {
      if (field.wire !== 2) continue;
      const digest = digestOf(field.bytes);

      if (digest) {
        out.push(digest);
        continue;
      }

      if (field.bytes.length > 32) walk(field.bytes, depth + 1);
    }
  };

  walk(bytes, 0);

  return out;
}

/** Pull interface used by export (async reads) and by in-memory checks. */
export interface BlobGraph {
  /** `unsupported` when `conversationState` is not decodable `_v:18` wire data. */
  status: 'ok' | 'unsupported';
  /** State-level blob keys, before nested records are loaded. */
  seeds(): string[];
  /** Digests whose bytes are still needed. */
  want(limit?: number): string[];
  /** Supply the current `want()` set. Null means the blob is absent. */
  provide(found: ReadonlyMap<string, Buffer | null>): void;
  /** Keys that were loaded, and required keys that were not. */
  finish(): { keys: string[]; missing: string[] };
}

/** Empty graph for a composer that has no conversation state. */
function idleGraph(): BlobGraph {
  return {
    status: 'ok',
    seeds: () => [],
    want: () => [],
    provide: () => undefined,
    finish: () => ({ keys: [], missing: [] }),
  };
}

/** Fail-closed graph. Seeds are empty so callers do not invent dependencies. */
function rejectedGraph(): BlobGraph {
  return {
    status: 'unsupported',
    seeds: () => [],
    want: () => [],
    provide: () => undefined,
    finish: () => ({ keys: [], missing: [] }),
  };
}

/** Walk `conversationState`. Absent state has no blob dependencies. */
export function openBlobGraph(state: unknown): BlobGraph {
  if (state === undefined || state === null) return idleGraph();

  let root: Buffer;

  try {
    root = decodeState(state);
  } catch {
    return rejectedGraph();
  }

  let seeds: Node[];

  try {
    seeds = refsFromState(root);
  } catch {
    return rejectedGraph();
  }

  return createGraph(seeds);
}

/** Breadth-first walk. Required ids that are absent stay in `missing`. */
function createGraph(seeds: Node[]): BlobGraph {
  const queue: Node[] = [];
  const roles = new Set<string>();
  const required = new Set<string>();
  const absent = new Set<string>();
  const found = new Set<string>();
  let cursor = 0;
  let status: BlobGraph['status'] = 'ok';

  /** A digest can be encountered in several roles; parse every newly learned role. */
  const push = (node: Node): void => {
    if (node.required) required.add(node.digest);
    const role = `${node.digest}:${node.kind}`;

    if (roles.has(role)) return;
    if (roles.size >= MAX_NODES)
      throw new Error('Blob graph exceeds 100000 roles.');
    roles.add(role);
    queue.push(node);
  };

  for (const node of seeds) push(node);

  return {
    /** `unsupported` after a blob payload cannot be parsed. */
    get status() {
      return status;
    },
    seeds: () => [...new Set(seeds.map((node) => blobKey(node.digest)))],
    want: (limit = 32) =>
      status === 'ok'
        ? [
            ...new Set(
              queue.slice(cursor, cursor + limit).map((node) => node.digest),
            ),
          ]
        : [],
    /** Parse the supplied frontier and enqueue newly discovered digests. */
    provide(batch) {
      const end = queue.length;

      // A bounded batch may cover only the first part of a wide frontier.
      while (cursor < end && batch.has(queue[cursor]!.digest)) {
        const node = queue[cursor++]!;
        const bytes = batch.get(node.digest);

        if (bytes === null || bytes === undefined) {
          absent.add(node.digest);
          continue;
        }

        found.add(blobKey(node.digest));

        try {
          for (const child of schemaRefs(node.kind, bytes)) push(child);
        } catch {
          status = 'unsupported';

          return;
        }

        if (node.kind === 'state') continue;
        for (const digest of looseDigests(bytes))
          push({ digest, kind: 'scan', required: false });
      }
    },
    finish: () => ({
      keys: [...found],
      missing: [...absent].filter((id) => required.has(id)).map(blobKey),
    }),
  };
}

/** Resolve a graph from blobs already in memory. */
export function resolveBlobGraph(
  state: unknown,
  blobs: ReadonlyMap<string, Buffer>,
): { status: 'ok' | 'unsupported'; keys: string[]; missing: string[] } {
  const graph = openBlobGraph(state);

  if (graph.status !== 'ok') {
    return { status: graph.status, keys: [], missing: [] };
  }

  for (;;) {
    const want = graph.want();

    if (!want.length) break;
    const batch = new Map<string, Buffer | null>();

    for (const digest of want) batch.set(digest, blobs.get(digest) ?? null);
    graph.provide(batch);
  }

  return { status: graph.status, ...graph.finish() };
}

/** Resolve a graph, loading each frontier through `loadMany`. */
export async function readBlobGraph(
  state: unknown,
  loadMany: (digests: string[]) => Promise<ReadonlyMap<string, Buffer | null>>,
  batchSize = 1,
): Promise<{
  /** `unsupported` when conversation state cannot be decoded. */
  status: 'ok' | 'unsupported';
  /** Blob keys that were loaded. */
  keys: string[];
  /** Required blob keys that were absent. */
  missing: string[];
}> {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 32)
    throw new Error('Blob graph batch size must be between 1 and 32.');
  const graph = openBlobGraph(state);

  if (graph.status !== 'ok') {
    return { status: graph.status, keys: [], missing: [] };
  }

  for (;;) {
    const want = graph.want(batchSize);

    if (!want.length) break;
    const found = await loadMany(want);

    // Byte-bounded readers may return a prefix instead of the whole frontier.
    if (!found.has(want[0]!)) throw new Error('Blob reader made no progress.');
    graph.provide(found);
  }

  return { status: graph.status, ...graph.finish() };
}
