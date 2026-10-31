/** Wire parser for `_v:18` conversationState. Not a complete Cursor codec. */

/** One decoded protobuf key/length-delimited field from conversationState. */
export interface WireField {
  /** Protobuf field number. */
  field: number;
  wire: number;
  /** Byte offset of the payload. */
  offset: number;
  /** Length-delimited payload bytes. */
  bytes: Buffer;
}

/** Reject conversationState payloads larger than this. */
const MAX_BYTES = 16 * 1024 * 1024;

/** Canonical UUID shape used by Cursor composer and root-bubble identities. */
const UUID_TEXT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Read a protobuf varint; reject truncated or overflowing encodings. */
function readVarint(bytes: Buffer, start: number): [bigint, number] {
  let value = 0n;
  let offset = start;

  for (let i = 0; i < 10; i++) {
    if (offset >= bytes.length) throw new Error('Truncated varint');
    const byte = bytes[offset++]!;

    if (i === 9 && byte > 1) throw new Error('Varint overflow');
    value |= BigInt(byte & 0x7f) << BigInt(7 * i);
    if ((byte & 0x80) === 0) return [value, offset];
  }

  throw new Error('Unterminated varint');
}

/** Decode a `~` + canonical base64 conversationState payload. */
export function decodeState(state: unknown): Buffer {
  if (typeof state !== 'string' || !state.startsWith('~')) {
    throw new Error('Unsupported conversationState encoding');
  }

  const encoded = state.slice(1);

  if (encoded.length > Math.ceil(MAX_BYTES / 3) * 4) {
    throw new Error('State size limit');
  }

  const bytes = Buffer.from(encoded, 'base64');

  if (bytes.length > MAX_BYTES || bytes.toString('base64') !== encoded) {
    throw new Error('Non-canonical or oversized base64');
  }

  return bytes;
}

/** Yield top-level protobuf fields; reject unsupported wire types. */
export function* readFields(bytes: Buffer): Generator<WireField> {
  if (bytes.length > MAX_BYTES) throw new Error('State size limit');
  let offset = 0;

  while (offset < bytes.length) {
    let tag: bigint;

    [tag, offset] = readVarint(bytes, offset);
    const field = Number(tag >> 3n);
    const wire = Number(tag & 7n);

    if (field < 1 || field > 536870911) throw new Error('Invalid field number');
    let start = offset;

    if (wire === 0) {
      [, offset] = readVarint(bytes, offset);
    } else if (wire === 1 || wire === 2 || wire === 5) {
      let size: bigint = wire === 1 ? 8n : 4n;

      if (wire === 2) [size, offset] = readVarint(bytes, offset);
      start = offset;
      if (size > BigInt(bytes.length - offset))
        throw new Error('Truncated field');
      offset += Number(size);
    } else {
      throw new Error('Unsupported wire type');
    }

    yield { field, wire, offset: start, bytes: bytes.subarray(start, offset) };
  }
}

/**
 * Field-1 LEN 32 hashes, in order, including duplicates.
 * These are candidates for `agentKv:blob:<hex>`, not a closure certificate.
 */
export function field1Candidates(state: unknown): string[] {
  return [...readFields(decodeState(state))]
    .filter(
      (row) => row.field === 1 && row.wire === 2 && row.bytes.length === 32,
    )
    .map((row) => row.bytes.toString('hex'));
}

/** Exact UUID-valued protobuf strings, including strings in nested messages. */
export function conversationStateIds(state: unknown): Set<string> {
  const ids = new Set<string>();

  collectIds(decodeState(state), ids);

  return ids;
}

/** Walk protobuf messages while treating arbitrary string fields as opaque. */
function collectIds(bytes: Buffer, ids: Set<string>, depth = 0): void {
  if (depth > 64) throw new Error('Conversation state nesting limit');

  for (const field of readFields(bytes)) {
    if (field.wire !== 2) continue;
    const text = field.bytes.toString('utf8');

    if (UUID_TEXT.test(text)) {
      ids.add(text);
      continue;
    }

    try {
      collectIds(field.bytes, ids, depth + 1);
    } catch {
      // Length-delimited strings and raw bytes need not be nested messages.
    }
  }
}

/** Rewrite fixed-width UUID references without changing protobuf framing. */
export function remapConversationStateIds(
  state: unknown,
  ids: ReadonlyMap<string, string>,
): unknown {
  if (typeof state !== 'string' || !state.startsWith('~') || ids.size === 0)
    return state;
  const bytes = decodeState(state);

  const replacements = new Map(
    [...ids]
      .filter(([source, target]) => source !== target)
      .map(([source, target]) => [
        Buffer.from(source, 'utf8').toString('hex'),
        Buffer.from(target, 'utf8'),
      ]),
  );

  for (const [source, target] of ids) {
    if (Buffer.byteLength(source) !== Buffer.byteLength(target)) {
      throw new Error('Conversation state ids must have equal byte lengths');
    }
  }

  remapMessage(bytes, replacements);

  return `~${bytes.toString('base64')}`;
}

/** Remap exact string fields while preserving unknown protobuf bytes. */
function remapMessage(
  bytes: Buffer,
  replacements: ReadonlyMap<string, Buffer>,
  depth = 0,
): void {
  if (depth > 64) throw new Error('Conversation state nesting limit');

  for (const field of readFields(bytes)) {
    if (field.wire !== 2) continue;
    const replacement = replacements.get(field.bytes.toString('hex'));

    if (replacement) {
      replacement.copy(bytes, field.offset);
      continue;
    }

    try {
      remapMessage(field.bytes, replacements, depth + 1);
    } catch {
      // An arbitrary string or byte field is not a nested protobuf message.
    }
  }
}
