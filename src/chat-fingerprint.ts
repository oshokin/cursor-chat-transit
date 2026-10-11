import { createHash } from 'node:crypto';
import { bubbleRange, sqlText } from './core';
import { execSql, execSqlHexRows } from './sqlite';
import type { SqliteSession } from './sqlite-session';
import type { TransferContext } from './types';

/**
 * Hash the selected global chat rows.
 * Unrelated Cursor writes, including `agentKv` and editor state, are not part of the hash.
 * Pass the open write session to read those rows inside its transaction.
 */
export async function chatSelectionFingerprint(
  /** Transfer hooks and the sqlite binary. */
  ctx: TransferContext,
  /** Global database that stores the chat rows. */
  database: string,
  /** Composer ids approved for this target. */
  ids: string[],
  /** Write session that already holds the deletion transaction. */
  session?: SqliteSession,
): Promise<string> {
  const hash = createHash('sha256');
  const sorted = [...new Set(ids)].sort();

  hash.update(sorted.join('\n'));

  if (!sorted.length) return hash.digest('hex');

  const conn = {
    ...ctx,
    database,
    readOnly: session ? undefined : true,
    session,
  };

  try {
    const hasTable = (
      await execSql({
        ...conn,
        sql: `SELECT count(*) FROM sqlite_schema WHERE type='table' AND name='composerHeaders';`,
      })
    ).trim();

    if (hasTable === '1') {
      await execSqlHexRows({
        ...conn,
        sql: `SELECT hex(composerId), hex(COALESCE(CAST(value AS BLOB), X'')) FROM composerHeaders WHERE composerId IN (${sorted.map((id) => sqlText(id)).join(',')}) ORDER BY composerId;`,
        cols: 2,
        onRow: (fields) => {
          hash.update(fields[0]);
          hash.update(fields[1]);
        },
      });
    }

    const batchSize = 64;

    for (let start = 0; start < sorted.length; start += batchSize) {
      const batch = sorted.slice(start, start + batchSize);

      const where = batch
        .map((id) => {
          const range = bubbleRange(id);

          return `key=${sqlText(`composerData:${id}`)} OR key=${sqlText(`composerRootWriterDiagnostic:${id}`)} OR (key>=${sqlText(range.lower)} AND key<${sqlText(range.upper)})`;
        })
        .join(' OR ');

      await execSqlHexRows({
        ...conn,
        sql: `SELECT hex(key), hex(COALESCE(CAST(value AS BLOB), X'')) FROM cursorDiskKV WHERE ${where} ORDER BY key;`,
        cols: 2,
        onRow: (fields) => {
          hash.update(fields[0]);
          hash.update(fields[1]);
        },
      });
    }

    return hash.digest('hex');
  } finally {
    // Hex reads switch the session separator. Later deletion statements expect `|`.
    if (session) await session.exec('.mode list\n.separator "|"');
  }
}
