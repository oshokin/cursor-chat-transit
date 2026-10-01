import { sqlText } from './core';
import { MAX_SQLITE_VALUE_BYTES } from './bundle-limits';
import type { KvBytes } from './db-read';
import type { SqliteSession } from './sqlite-session';

/** Read one bounded KV value in one SQLite statement, with bounded protocol lines. */
export async function readSessionKv(
  session: SqliteSession,
  key: string,
): Promise<KvBytes | null> {
  const chunks: Buffer[] = [];
  let storageClass: KvBytes['storageClass'] | undefined;
  let expected = 0;

  // One statement holds a consistent read snapshot. Each hex line is at most 2 MiB.
  await session.queryLines(
    `WITH RECURSIVE payload AS (
    SELECT value FROM cursorDiskKV WHERE key=${sqlText(key)}
  ), chunks(pos) AS (
    VALUES(1) UNION ALL SELECT pos + 1048576 FROM chunks, payload
    WHERE pos + 1048576 <= length(CAST(value AS BLOB)) AND length(CAST(value AS BLOB)) <= ${MAX_SQLITE_VALUE_BYTES}
  ) SELECT typeof(value) || '|' || length(CAST(value AS BLOB)) || '|' ||
    CASE WHEN length(CAST(value AS BLOB)) <= ${MAX_SQLITE_VALUE_BYTES} THEN hex(substr(CAST(value AS BLOB), pos, 1048576)) ELSE '' END
    FROM chunks, payload;`,
    (line) => {
      const [kind, length, hex = ''] = line.split('|');

      if (kind !== 'text' && kind !== 'blob')
        throw new Error(`Unsupported SQLite storage class for ${key}.`);
      expected = Number(length);
      if (expected > MAX_SQLITE_VALUE_BYTES)
        throw new Error(
          `Resource ${key} exceeds ${MAX_SQLITE_VALUE_BYTES} bytes.`,
        );
      storageClass = kind;
      chunks.push(Buffer.from(hex, 'hex'));
    },
  );

  if (!storageClass) return null;
  const bytes = chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks);

  if (bytes.length !== expected)
    throw new Error(`Incomplete SQLite response for ${key}.`);

  return { storageClass, bytes };
}
