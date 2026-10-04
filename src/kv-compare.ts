import { sha256Hex } from './resource-bytes';

/** Why an existing cursorDiskKV row cannot be reused for an incoming resource. */
export type KvConflictReason = 'storage-class' | 'content' | 'both';

/** Metadata for one conflicting key. Byte values are never included. */
export interface KvConflictFacts {
  /** storage-class, content, or both. */
  reason: KvConflictReason;
  /** SQLite storage class of the destination row. */
  existingClass: string;
  /** SQLite storage class recorded for the incoming row. */
  incomingClass: string;
  /** Destination payload size. */
  existingBytes: number;
  /** Incoming payload size. */
  incomingBytes: number;
  /** SHA-256 of the destination bytes. */
  existingSha256: string;
  /** SHA-256 of the incoming bytes. */
  incomingSha256: string;
}

/**
 * Destination alias `t` versus staged alias `s`.
 * Same rule as `classifyKvConflict`: storage class or raw bytes.
 */
export const KV_ROW_MISMATCH_SQL =
  'typeof(t.value) != typeof(s.value) OR CAST(t.value AS BLOB) != CAST(s.value AS BLOB)';

/** Compare class and content hash. Matching rows return null. */
export function classifyKvConflict(
  /** SQLite storage class of the value. */
  existing: {
    storageClass: string;
    bytes: Buffer;
  },
  /** SQLite storage class of the value. */
  incoming: {
    /** SQLite storage class of the incoming value. */
    storageClass: string;
    /** SHA-256 of the incoming bytes. */
    sha256: string;
    /** Decoded byte length of the incoming value. */
    byteLength: number;
  },
): KvConflictFacts | null {
  const existingSha256 = sha256Hex(existing.bytes);
  const incomingClass = incoming.storageClass || 'blob';
  const classDiff = existing.storageClass !== incomingClass;
  const contentDiff = existingSha256 !== incoming.sha256;

  if (!classDiff && !contentDiff) return null;

  let reason: KvConflictReason = 'content';

  if (classDiff && contentDiff) reason = 'both';
  else if (classDiff) reason = 'storage-class';

  return {
    reason,
    existingClass: existing.storageClass,
    incomingClass,
    existingBytes: existing.bytes.length,
    incomingBytes: incoming.byteLength,
    existingSha256,
    incomingSha256: incoming.sha256,
  };
}

/**
 * Raw bytes when the destination cell is the hex spelling of the addressed blob.
 * Any other mismatch returns null. The caller keeps the original row.
 */
export function hexTextOfAddressedBlob(
  /** SQLite storage class of the value. */
  existing: {
    storageClass: string;
    bytes: Buffer;
  },
  /** SQLite storage class of the value. */
  incoming: {
    /** SQLite storage class of the incoming value. */
    storageClass: string;
    /** SHA-256 of the incoming bytes. */
    sha256: string;
    /** Decoded byte length of the incoming value. */
    byteLength: number;
  },
  key: string,
): Buffer | null {
  const incomingClass = incoming.storageClass || 'blob';

  if (existing.storageClass !== 'text' || incomingClass !== 'blob') return null;
  if (!blobKeyMatchesDigest(key, incoming.sha256)) return null;
  if (existing.bytes.length !== incoming.byteLength * 2) return null;

  if (
    existing.bytes.length % 2 !== 0 ||
    !/^[0-9a-fA-F]+$/.test(existing.bytes.toString('utf8'))
  ) {
    return null;
  }

  const decoded = Buffer.from(existing.bytes.toString('utf8'), 'hex');

  if (
    decoded.length !== incoming.byteLength ||
    sha256Hex(decoded) !== incoming.sha256
  ) {
    return null;
  }

  return decoded;
}

/** True when `agentKv:blob:` plus 64 lowercase hex equals this digest. */
export function blobKeyMatchesDigest(key: string, digest: string): boolean {
  const prefix = 'agentKv:blob:';

  if (!key.startsWith(prefix)) return false;
  const suffix = key.slice(prefix.length);

  return /^[0-9a-f]{64}$/.test(suffix) && suffix === digest;
}

/** One log record: classes, sizes, hashes, and whether the key is the content address. */
export function kvConflictDetail(
  facts: KvConflictFacts,
  key: string,
  phase: 'preflight' | 'write' | 'verify',
): string {
  return [
    `phase=${phase}`,
    `reason=${facts.reason}`,
    `key=${key}`,
    `existingClass=${facts.existingClass}`,
    `incomingClass=${facts.incomingClass}`,
    `existingBytes=${facts.existingBytes}`,
    `incomingBytes=${facts.incomingBytes}`,
    `existingSha256=${facts.existingSha256}`,
    `incomingSha256=${facts.incomingSha256}`,
    `keyMatchesExisting=${blobKeyMatchesDigest(key, facts.existingSha256)}`,
    `keyMatchesIncoming=${blobKeyMatchesDigest(key, facts.incomingSha256)}`,
  ].join(' ');
}
