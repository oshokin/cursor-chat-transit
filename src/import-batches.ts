import { sqlText } from './core';
import { isResourceConflict } from './db-write';
import {
  classifyKvConflict,
  KV_ROW_MISMATCH_SQL,
  kvConflictDetail,
} from './kv-compare';
import { readSessionKv } from './kv-session';
import { sha256Hex } from './resource-bytes';
import { SqliteSession } from './sqlite-session';
import { traceIO, transferEvent } from './transfer-events';
import { TransferError, type SqliteConn, type TransferContext } from './types';

/** Bound each write transaction by bytes and row count. One legal row may exceed this budget. */
export const IMPORT_BATCH_BYTES = 8 * 1024 * 1024;

/** Copy immutable dependencies and hidden bubbles; publish the composer in a later transaction. */
export async function writePreparedBatches(opts: {
  /** Writable connection to the destination database. */
  conn: SqliteConn;
  /** Temporary database that holds the prepared rows. */
  stagedPath: string;
  /** KV key of the composer row, published in a later transaction. */
  composerKey: string;
  /** Transfer hooks and cancellation. */
  ctx: TransferContext;
  /** Called after a batch has been committed. */
  onDurable?: () => void;
}): Promise<void> {
  const session = await SqliteSession.open({ ...opts.conn, readOnly: false });

  try {
    await session.exec(`ATTACH DATABASE ${sqlText(opts.stagedPath)} AS staged;
CREATE TEMP TABLE cct_batch_guard(ok INTEGER CONSTRAINT cct_resource_conflict CHECK(ok=1));`);

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

      await rejectChangedBatch(session, opts, selected);

      await traceIO(
        'Commit prepared batch',
        { path: opts.conn.database, bytes },
        () =>
          session.exec(`BEGIN IMMEDIATE;
DELETE FROM cct_batch_guard;
INSERT INTO cct_batch_guard SELECT 0 FROM main.cursorDiskKV t JOIN staged.cursorDiskKV s USING(key)
WHERE ${selected} AND (${KV_ROW_MISMATCH_SQL}) LIMIT 1;
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
  } catch (err) {
    if (err instanceof TransferError && err.code === 'RESOURCE_CONFLICT') {
      throw err;
    }

    if (!isResourceConflict(err) && !guardFailure(err)) throw err;

    const conflict = new TransferError(
      'A required chat resource already exists with different data.',
    );

    conflict.code = 'RESOURCE_CONFLICT';
    conflict.detail = 'phase=write';

    throw conflict;
  } finally {
    await session.close();
  }
}

/** Refuse a batch whose destination row changed after the preflight check. */
async function rejectChangedBatch(
  session: SqliteSession,
  opts: {
    /** Writable connection to the destination database. */
    conn: SqliteConn;
    /** Temporary database that holds the prepared rows. */
    stagedPath: string;
  },
  selected: string,
): Promise<void> {
  const line = (
    await session.exec(
      `SELECT json_object('key', s.key) FROM main.cursorDiskKV t JOIN staged.cursorDiskKV s USING(key) WHERE ${selected} AND (${KV_ROW_MISMATCH_SQL}) LIMIT 1;`,
    )
  ).trim();

  if (!line) return;
  const key = String((JSON.parse(line) as { key?: string }).key || '');

  if (!key) return;
  const existing = await readSessionKv(session, key);

  const staged = await SqliteSession.open({
    ...opts.conn,
    database: opts.stagedPath,
    readOnly: true,
  });

  try {
    const incoming = await readSessionKv(staged, key);

    if (!existing || !incoming) return;

    const facts = classifyKvConflict(existing, {
      storageClass: incoming.storageClass,
      sha256: sha256Hex(incoming.bytes),
      byteLength: incoming.bytes.length,
    });

    if (!facts) return;

    const detail = kvConflictDetail(facts, key, 'write');

    transferEvent({
      action: 'KV resource conflict',
      status: 'failed',
      path: opts.conn.database,
      key,
      errorCode: 'RESOURCE_CONFLICT',
      detail,
    });

    const err = new TransferError(
      'A required chat resource already exists with different data.',
    );

    err.code = 'RESOURCE_CONFLICT';
    err.detail = detail;

    throw err;
  } finally {
    await staged.close();
  }
}

/** True when the in-transaction batch guard rejected a changed row. */
function guardFailure(err: unknown): boolean {
  const text =
    err instanceof Error
      ? `${err.message} ${'stderr' in err ? String((err as { stderr?: string }).stderr || '') : ''}`
      : String(err);

  return text.includes('cct_batch_guard');
}
