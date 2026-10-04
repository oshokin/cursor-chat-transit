import * as db from './db';
import { sqlText } from './core';
import { sha256Text } from './import-policy';
import { JournalStore, type PendingChatRow } from './journal-db';
import { SqliteSession } from './sqlite-session';
import { traceIO } from './transfer-events';
import { TransferError, type Layout, type SqliteConn } from './types';
import { IMPORT_BATCH_BYTES } from './import-batches';

/** Recover an unpublished partial chat; never delete modified, unknown or published rows. */
export async function cleanUnpublishedBubbles(opts: {
  /** Journal that recorded the expected bubble hashes. */
  journal: JournalStore;
  /** Pending operation being recovered. */
  operationId: string;
  /** Chat whose unpublished rows may be removed. */
  chat: PendingChatRow;
  /** Writable connection to the destination database. */
  conn: SqliteConn;
  /** Destination schema, used to choose the bubble table. */
  layout: Layout;
}): Promise<void> {
  const expected = new Map<string, string>();

  await opts.journal.forEachBubble(
    opts.operationId,
    opts.chat.targetComposerId,
    (
      id,
      /** Content hash. */
      hash,
    ) => {
      expected.set(id, hash);
    },
  );

  const present = await db.listBubbleIds(opts.conn, opts.chat.targetComposerId);

  if (!present.size) return;

  /** Build the error used when an unpublished chat changed. */
  const problem = () => {
    const error = new TransferError(
      'An unfinished chat changed. Its rows were preserved; inspect the operation log.',
    );

    error.code = 'NEEDS_ATTENTION';

    return error;
  };

  for (const id of present) if (!expected.has(id)) throw problem();
  const session = await SqliteSession.open({ ...opts.conn, readOnly: false });
  let batch: Array<[string, string]> = [];
  let bytes = 0;
  const composerKey = `composerData:${opts.chat.targetComposerId}`;
  const id = sqlText(opts.chat.targetComposerId);

  /** Insert the queued bubble rows. */
  const flush = async () => {
    if (!batch.length) return;

    const values = batch
      .map(
        (/** KV key and the text stored for it. */ [key, text]) =>
          `(${sqlText(key)},${sqlText(text)})`,
      )
      .join(',');

    const keys = batch
      .map((/** KV key from the queued batch. */ [key]) => sqlText(key))
      .join(',');

    const headers = [
      opts.layout.composerHeaders
        ? `INSERT INTO cct_cleanup_guard SELECT 0 FROM composerHeaders WHERE composerId=${id};`
        : '',
      opts.layout.itemTable
        ? `INSERT INTO cct_cleanup_guard SELECT 0 FROM ItemTable i, json_each(i.value,'$.allComposers') j WHERE i.key='composer.composerHeaders' AND json_extract(j.value,'$.composerId')=${id};`
        : '',
    ].join('\n');

    await traceIO(
      'Remove verified unpublished messages',
      { path: opts.conn.database, chatId: opts.chat.targetComposerId, bytes },
      () =>
        session.exec(`BEGIN IMMEDIATE;
DELETE FROM cct_cleanup_guard;
INSERT INTO cct_cleanup_guard SELECT 0 FROM cursorDiskKV WHERE key=${sqlText(composerKey)};
${headers}
WITH expected(key,value) AS (VALUES ${values})
INSERT INTO cct_cleanup_guard SELECT 0 FROM cursorDiskKV t JOIN expected e USING(key) WHERE CAST(t.value AS BLOB) != CAST(e.value AS BLOB) LIMIT 1;
DELETE FROM cursorDiskKV WHERE key IN (${keys});
COMMIT;`),
    );

    batch = [];
    bytes = 0;
  };

  try {
    await session.exec(
      'CREATE TEMP TABLE cct_cleanup_guard(ok INTEGER CHECK(ok=1));',
    );

    for (const bubble of present) {
      const key = `bubbleId:${opts.chat.targetComposerId}:${bubble}`;
      const text = await db.readKvText(opts.conn, key);

      if (text === null) continue;
      if (sha256Text(text) !== expected.get(bubble)) throw problem();
      const size = Buffer.byteLength(text);

      if (
        batch.length &&
        (bytes + size > IMPORT_BATCH_BYTES || batch.length >= 128)
      )
        await flush();
      batch.push([key, text]);
      bytes += size;
    }

    await flush();
  } finally {
    await session.close();
  }
}
