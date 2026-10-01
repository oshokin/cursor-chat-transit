import { sqlText } from './core';
import { SqliteSession } from './sqlite-session';
import { traceIO } from './transfer-events';
import type { SqliteConn, TransferContext } from './types';

/** Bound each write transaction by bytes and row count. One legal row may exceed this budget. */
export const IMPORT_BATCH_BYTES = 8 * 1024 * 1024;

/** Copy immutable dependencies and hidden bubbles; publish the composer in a later transaction. */
export async function writePreparedBatches(opts: {
  conn: SqliteConn;
  stagedPath: string;
  composerKey: string;
  ctx: TransferContext;
  onDurable?: () => void;
}): Promise<void> {
  const session = await SqliteSession.open({ ...opts.conn, readOnly: false });

  try {
    await session.exec(`ATTACH DATABASE ${sqlText(opts.stagedPath)} AS staged;
CREATE TEMP TABLE cct_batch_guard(ok INTEGER CHECK(ok=1));`);

    const total = Number(
      (
        await session.exec(
          `SELECT count(*) FROM staged.cursorDiskKV WHERE key != ${sqlText(opts.composerKey)};`,
        )
      ).trim(),
    );

    let after = 0;
    let processed = 0;

    opts.ctx.onPhase?.('write', { processed, total, unit: 'records' });

    for (;;) {
      opts.ctx.signal?.throwIfAborted();
      const rows: Array<[number, number]> = [];

      await session.queryLines(
        `SELECT json_array(rowid,length(CAST(value AS BLOB))) FROM staged.cursorDiskKV WHERE rowid>${after} AND key != ${sqlText(opts.composerKey)} ORDER BY rowid LIMIT 128;`,
        (line) => {
          rows.push(JSON.parse(line) as [number, number]);
        },
      );

      if (!rows.length) break;
      let bytes = 0;
      let count = 0;
      let end = after;

      for (const [id, size] of rows) {
        if (count && bytes + size > IMPORT_BATCH_BYTES) break;
        bytes += size;
        count++;
        end = id;
      }

      const selected = `s.rowid>${after} AND s.rowid<=${end} AND s.key != ${sqlText(opts.composerKey)}`;

      await traceIO(
        'Commit prepared batch',
        { path: opts.conn.database, bytes },
        () =>
          session.exec(`BEGIN IMMEDIATE;
DELETE FROM cct_batch_guard;
INSERT INTO cct_batch_guard SELECT 0 FROM main.cursorDiskKV t JOIN staged.cursorDiskKV s USING(key)
WHERE ${selected} AND (typeof(t.value) != typeof(s.value) OR CAST(t.value AS BLOB) != CAST(s.value AS BLOB)) LIMIT 1;
INSERT INTO main.cursorDiskKV(key,value) SELECT s.key,s.value FROM staged.cursorDiskKV s WHERE ${selected}
AND NOT EXISTS(SELECT 1 FROM main.cursorDiskKV t WHERE t.key=s.key);
COMMIT;`),
      );

      opts.onDurable?.();
      after = end;
      processed += count;
      opts.ctx.onPhase?.('write', { processed, total, unit: 'records' });
      // Yield between transactions so cancellation and competing writers can run.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  } finally {
    await session.close();
  }
}
