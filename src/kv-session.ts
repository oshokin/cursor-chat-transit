import { sqlText } from './core';
import { MAX_SQLITE_VALUE_BYTES } from './bundle-limits';
import type { KvBytes } from './db-read';
import type { SqliteSession } from './sqlite-session';

/** Maximum payload sum per batch; one larger bounded record is read alone. */
export const KV_BATCH_BYTES = 4 * 1024 * 1024;

/** Read one bounded KV value in one SQLite statement, with bounded protocol lines. */
export async function readSessionKv(
  session: SqliteSession,
  key: string,
): Promise<KvBytes | null> {
  const collector = collectValue(key);

  await session.queryLines(valueQuery(key), collector.line);

  return collector.finish();
}

/**
 * Read a byte-bounded prefix of up to 32 keys in two IPC round trips.
 * The caller owns a read transaction; metadata and payload must share its view.
 */
export async function readSessionKvBatch(
  session: SqliteSession,
  keys: string[],
): Promise<Map<string, KvBytes | null>> {
  if (!keys.length || keys.length > 32 || new Set(keys).size !== keys.length)
    throw new Error('KV batch requires 1 to 32 distinct keys.');
  const sizes = new Map<number, number>();

  await session.queryLines(
    `WITH requested(idx,key) AS (VALUES ${keys.map((key, i) => `(${i},${sqlText(key)})`).join(',')})
    SELECT idx || '|' || CASE WHEN kv.key IS NULL THEN -1 ELSE coalesce(length(CAST(kv.value AS BLOB)), 0) END
    FROM requested LEFT JOIN cursorDiskKV kv ON kv.key=requested.key ORDER BY idx;`,
    (line) => {
      const [index, bytes] = line.split('|').map(Number);

      if (
        !Number.isSafeInteger(index) ||
        !Number.isSafeInteger(bytes) ||
        bytes < -1
      )
        throw new Error('Invalid SQLite size response.');
      sizes.set(index, bytes);
    },
  );

  const selected: string[] = [];
  let total = 0;

  for (const [i, key] of keys.entries()) {
    const bytes = sizes.get(i);

    if (bytes === undefined)
      throw new Error(`Missing size response for ${key}.`);
    if (selected.length && total + Math.max(0, bytes) > KV_BATCH_BYTES) break;
    if (bytes > MAX_SQLITE_VALUE_BYTES)
      throw new Error(
        `Resource ${key} exceeds ${MAX_SQLITE_VALUE_BYTES} bytes.`,
      );
    selected.push(key);
    total += Math.max(0, bytes);
    if (total >= KV_BATCH_BYTES) break;
  }

  const collectors = selected.map((key, i) => collectValue(key, sizes.get(i)));

  await session.queryLines(
    selected.map((key, i) => valueQuery(key, `${i}|`)).join('\n'),
    (line) => {
      const separator = line.indexOf('|');
      const index = Number(line.slice(0, separator));

      if (!Number.isInteger(index) || !collectors[index])
        throw new Error('Invalid SQLite batch response.');
      collectors[index]!.line(line.slice(separator + 1));
    },
  );

  return new Map(selected.map((key, i) => [key, collectors[i]!.finish()]));
}

/** Chunk a single record so no encoded protocol line exceeds 2 MiB. Oversized values return length only. */
function valueQuery(key: string, prefix = ''): string {
  const keySql = sqlText(key);
  const lead = sqlText(prefix);
  const size = `coalesce(length(CAST(value AS BLOB)), 0)`;

  return `SELECT ${lead} || typeof(value) || '|' || ${size} || '|'
    FROM cursorDiskKV WHERE key=${keySql} AND ${size} > ${MAX_SQLITE_VALUE_BYTES}
    UNION ALL
    SELECT ${lead} || typeof(value) || '|' || ${size} || '|' || hex(substr(CAST(value AS BLOB), pos, 1048576))
    FROM cursorDiskKV, (
      WITH RECURSIVE chunks(pos) AS (
        VALUES(1) UNION ALL SELECT pos + 1048576 FROM chunks
        WHERE pos <= ${MAX_SQLITE_VALUE_BYTES}
          AND pos + 1048576 <= (SELECT ${size} FROM cursorDiskKV WHERE key=${keySql})
      ) SELECT pos FROM chunks
    )
    WHERE key=${keySql} AND ${size} <= ${MAX_SQLITE_VALUE_BYTES};`;
}

/** Validate chunk metadata before allocating bytes; retain SQLite text/blob identity. */
function collectValue(key: string, probedBytes?: number) {
  const chunks: Buffer[] = [];
  let storageClass: KvBytes['storageClass'] | undefined;
  let expected = 0;
  let received = 0;

  return {
    /** Consume one bounded encoded chunk. */
    line(line: string): void {
      const [kind, length, hex = ''] = line.split('|');

      if (kind !== 'text' && kind !== 'blob')
        throw new Error(`Unsupported SQLite storage class for ${key}.`);
      expected = Number(length);
      if (expected > MAX_SQLITE_VALUE_BYTES)
        throw new Error(
          `Resource ${key} exceeds ${MAX_SQLITE_VALUE_BYTES} bytes.`,
        );
      if (probedBytes !== undefined && expected !== probedBytes)
        throw new Error(`SQLite read view changed for ${key}.`);
      if (!Number.isSafeInteger(expected) || expected < 0 || hex.length % 2)
        throw new Error(`Invalid SQLite response for ${key}.`);
      received += hex.length / 2;
      if (received > expected)
        throw new Error(`Incomplete SQLite response for ${key}.`);
      storageClass = kind;
      chunks.push(Buffer.from(hex, 'hex'));
    },
    /** Complete one value, distinguishing a missing row from an empty blob. */
    finish(): KvBytes | null {
      if (!storageClass) {
        if (probedBytes !== undefined && probedBytes >= 0)
          throw new Error(`SQLite read view changed for ${key}.`);

        return null;
      }

      const bytes = chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks);

      if (bytes.length !== expected)
        throw new Error(`Incomplete SQLite response for ${key}.`);

      return { storageClass, bytes };
    },
  };
}
