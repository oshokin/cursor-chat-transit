import { MAX_SQLITE_VALUE_BYTES } from './bundle-limits';
import type { KvBytes } from './db-read';
import type { SqliteSession } from './sqlite-session';

/** Payload budget for a dependency frontier; one legal larger value is read alone. */
export const KV_BATCH_BYTES = 4 * 1024 * 1024;

/** Read one value atomically, rejecting oversize payloads before materializing their bytes. */
export async function readSessionKv(
  session: SqliteSession,
  key: string,
): Promise<KvBytes | null> {
  let result: KvBytes | null = null;

  await session.rows(
    `SELECT typeof(value), coalesce(length(CAST(value AS BLOB)),0),
    CASE WHEN length(CAST(value AS BLOB)) <= ${MAX_SQLITE_VALUE_BYTES} THEN CAST(value AS BLOB) ELSE NULL END
    FROM cursorDiskKV WHERE key=?;`,
    [key],
    ([kind, length, bytes]) => {
      if (Number(length) > MAX_SQLITE_VALUE_BYTES)
        throw new Error(
          `Resource ${key} exceeds ${MAX_SQLITE_VALUE_BYTES} bytes.`,
        );
      if (kind !== 'text' && kind !== 'blob')
        throw new Error(`Unsupported SQLite storage class for ${key}.`);
      if (!Buffer.isBuffer(bytes))
        throw new Error(`Invalid SQLite response for ${key}.`);
      result = { storageClass: kind, bytes };
    },
  );

  return result;
}

/** Read a byte-bounded frontier from the caller's stable transaction. */
export async function readSessionKvBatch(
  session: SqliteSession,
  keys: string[],
): Promise<Map<string, KvBytes | null>> {
  if (!keys.length || keys.length > 32 || new Set(keys).size !== keys.length)
    throw new Error('KV batch requires 1 to 32 distinct keys.');
  const result = new Map<string, KvBytes | null>();
  const sizes = new Map<string, number>();

  await session.rows(
    `SELECT key,coalesce(length(CAST(value AS BLOB)),0) FROM cursorDiskKV WHERE key IN (${keys.map(() => '?').join(',')});`,
    keys,
    ([key, size]) => {
      sizes.set(String(key), Number(size));
    },
  );

  let total = 0;
  const selected: string[] = [];

  for (const key of keys) {
    const size = sizes.get(key) ?? 0;

    if (selected.length && total + size > KV_BATCH_BYTES) break;
    if (size > MAX_SQLITE_VALUE_BYTES)
      throw new Error(
        `Resource ${key} exceeds ${MAX_SQLITE_VALUE_BYTES} bytes.`,
      );
    selected.push(key);
    total += size;
    if (total >= KV_BATCH_BYTES) break;
  }

  const found = new Map<string, KvBytes>();

  await session.rows(
    `SELECT key,typeof(value),CAST(value AS BLOB) FROM cursorDiskKV WHERE key IN (${selected.map(() => '?').join(',')});`,
    selected,
    ([key, kind, bytes]) => {
      if (kind !== 'text' && kind !== 'blob')
        throw new Error(`Unsupported SQLite storage class for ${key}.`);
      if (!Buffer.isBuffer(bytes) || bytes.length !== sizes.get(String(key)))
        throw new Error(`SQLite read view changed for ${key}.`);
      found.set(String(key), { storageClass: kind, bytes });
    },
  );

  for (const key of selected) result.set(key, found.get(key) ?? null);

  return result;
}
