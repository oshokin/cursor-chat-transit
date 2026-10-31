import { createHash } from 'node:crypto';
import { bubbleRange, sqlText } from './core';
import { execSql, execSqlByteRows } from './sqlite';
import { SQLITE_PARAMETER_BATCH_ROWS } from './sqlite-protocol';
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

  {
    const hasTable = (
      await execSql({
        ...conn,
        sql: `SELECT count(*) FROM sqlite_schema WHERE type='table' AND name='composerHeaders';`,
      })
    ).trim();

    if (hasTable === '1') {
      for (
        let start = 0;
        start < sorted.length;
        start += SQLITE_PARAMETER_BATCH_ROWS
      ) {
        const batch = sorted.slice(start, start + SQLITE_PARAMETER_BATCH_ROWS);

        await execSqlByteRows({
          ...conn,
          sql: `SELECT CAST(composerId AS BLOB), CAST(COALESCE(CAST(value AS BLOB), X'') AS BLOB) FROM composerHeaders WHERE composerId IN (${batch.map((id) => sqlText(id)).join(',')}) ORDER BY composerId;`,
          onRow: (fields) => {
            hash.update(fields[0]);
            hash.update(fields[1]);
          },
        });
      }
    }

    for (
      let start = 0;
      start < sorted.length;
      start += SQLITE_PARAMETER_BATCH_ROWS
    ) {
      const batch = sorted.slice(start, start + SQLITE_PARAMETER_BATCH_ROWS);

      const where = batch
        .map((id) => {
          const range = bubbleRange(id);

          return `key=${sqlText(`composerData:${id}`)} OR key=${sqlText(`composerRootWriterDiagnostic:${id}`)} OR (key>=${sqlText(range.lower)} AND key<${sqlText(range.upper)})`;
        })
        .join(' OR ');

      await execSqlByteRows({
        ...conn,
        sql: `SELECT CAST(key AS BLOB), CAST(COALESCE(CAST(value AS BLOB), X'') AS BLOB) FROM cursorDiskKV WHERE ${where} ORDER BY key;`,
        onRow: (fields) => {
          hash.update(fields[0]);
          hash.update(fields[1]);
        },
      });
    }

    return hash.digest('hex');
  }
}
