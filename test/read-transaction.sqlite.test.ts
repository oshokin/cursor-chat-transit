import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { openReadTransaction } from '../src/read-transaction';
import { SqliteSession } from '../src/sqlite-session';
import {
  ensureInitFile,
  execSqlScript,
  findSqliteExecutable,
} from '../src/sqlite';
import { sqlText } from '../src/core';
import * as db from '../src/db';
import { exportToFile } from '../src/export-transfer';
import { readBundleObject } from '../src/bundle-object';
import { observeTransfer, type TransferEvent } from '../src/transfer-events';
import type { TransferContext, WorkspaceEntry } from '../src/types';

/** Tests operate exclusively on temporary databases. */
const executable = findSqliteExecutable(process.env.SQLITE3_PATH)!;
const skip = !executable;

/** Global and workspace databases with a writer kept open so WAL persists. */
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cct-read-view-'));
  const cleanup: { writer?: SqliteSession } = {};

  t.after(async () => {
    await cleanup.writer?.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  const ctx: TransferContext = {
    executable,
    initFile: await ensureInitFile(root),
    timeoutMs: 10000,
  };

  const workspace: WorkspaceEntry = {
    storageRoot: root,
    storageId: 'fixture',
    globalDbPath: path.join(root, 'global.vscdb'),
    workspaceDbPath: path.join(root, 'workspace.vscdb'),
    mtime: 0,
    key: 'fixture',
  };

  const conn = { ...ctx, database: workspace.globalDbPath };

  const writer = await SqliteSession.open(conn);

  cleanup.writer = writer;

  await writer.exec(
    'PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE ItemTable(key TEXT PRIMARY KEY,value BLOB); CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY,value BLOB);',
  );

  await execSqlScript({
    ...ctx,
    database: workspace.workspaceDbPath,
    sql: 'PRAGMA journal_mode=WAL; CREATE TABLE ItemTable(key TEXT PRIMARY KEY,value BLOB);',
  });

  return { root, ctx, conn, workspace, writer };
}

test(
  'read view sees committed WAL, stays stable under writes, and releases checkpoint before returning',
  { skip },
  async (t) => {
    const { conn, writer } = await fixture(t);

    await writer.exec("INSERT INTO cursorDiskKV VALUES('k','v1');");
    const view = await openReadTransaction(conn);

    try {
      assert.equal(await db.readKvText(view.conn, 'k'), 'v1');

      await writer.exec(
        "UPDATE cursorDiskKV SET value='v2'; INSERT INTO cursorDiskKV VALUES('later','new');",
      );

      assert.equal(await db.readKvText(view.conn, 'k'), 'v1');
      assert.equal(await db.readKvText(view.conn, 'later'), null);

      await assert.rejects(
        () => view.conn.session!.exec('DELETE FROM cursorDiskKV;'),
        /SQLite/,
      );
    } finally {
      await view.close();
      await view.close();
    }

    assert.equal(await db.readKvText(conn, 'k'), 'v2');

    assert.match(
      (
        await writer.exec('.timeout 0\nPRAGMA wal_checkpoint(TRUNCATE);')
      ).trim(),
      /^0\|0\|0$/,
    );
  },
);

test(
  'cancelling a read transaction frees the WAL snapshot',
  { skip },
  async (t) => {
    const { conn, writer } = await fixture(t);
    const controller = new AbortController();

    const view = await openReadTransaction({
      ...conn,
      signal: controller.signal,
    });

    await writer.exec("INSERT INTO cursorDiskKV VALUES('new','data');");
    controller.abort(new DOMException('Cancelled', 'AbortError'));
    await view.close();

    assert.match(
      (
        await writer.exec('.timeout 0\nPRAGMA wal_checkpoint(TRUNCATE);')
      ).trim(),
      /^0\|0\|0$/,
    );
  },
);

test(
  'export keeps headers, messages and blobs in one view and closes it before packaging',
  { skip },
  async (t) => {
    const { root, ctx, conn, workspace, writer } = await fixture(t);
    const id = '11111111-1111-4111-8111-111111111111';
    const blob = Buffer.from('original blob');
    const digest = createHash('sha256').update(blob).digest('hex');

    // Cursor field-1 legacy conversation state: a referenced 32-byte blob id.
    const state =
      '~' +
      Buffer.concat([
        Buffer.from([0x0a, 0x20]),
        Buffer.from(digest, 'hex'),
      ]).toString('base64');

    const header = {
      composerId: id,
      name: 'Original',
      workspaceIdentifier: { id: 'fixture' },
    };

    const body = {
      composerId: id,
      fullConversationHeadersOnly: [{ bubbleId: 'b' }],
      conversationState: state,
    };

    const bubble = { bubbleId: 'b', text: 'x'.repeat(3 * 1024 * 1024) };

    await writer.exec(`INSERT INTO ItemTable VALUES('composer.composerHeaders',${sqlText(JSON.stringify({ allComposers: [header] }))});
    INSERT INTO cursorDiskKV VALUES('composerData:11111111-1111-4111-8111-111111111111',${sqlText(JSON.stringify(body))}),('bubbleId:11111111-1111-4111-8111-111111111111:b',${sqlText(JSON.stringify(bubble))}),('agentKv:blob:${digest}',X'${blob.toString('hex')}');
    INSERT INTO cursorDiskKV VALUES('unrelated-large-value',zeroblob(40 * 1024 * 1024));`);

    let changed = false;
    const oldHook = db.testHooks.readKvText;

    db.testHooks.readKvText = async (readConn, key) => {
      if (
        !changed &&
        key === 'composerData:11111111-1111-4111-8111-111111111111'
      ) {
        changed = true;

        await writer.exec(`UPDATE ItemTable SET value=${sqlText(JSON.stringify({ allComposers: [{ ...header, name: 'Changed' }] }))};
        UPDATE cursorDiskKV SET value='{"composerId":"chat","changed":true}' WHERE key='composerData:11111111-1111-4111-8111-111111111111';
        UPDATE cursorDiskKV SET value='{"bubbleId":"b","text":"changed"}' WHERE key='bubbleId:11111111-1111-4111-8111-111111111111:b';
        DELETE FROM cursorDiskKV WHERE key='agentKv:blob:${digest}';`);
      }

      return db.readKvTextImpl(readConn, key);
    };

    t.after(async () => {
      db.testHooks.readKvText = oldHook;
    });

    const events: TransferEvent[] = [];
    let checkpoint: Promise<string> | undefined;
    const destination = path.join(root, 'export.zip');

    const summary = await observeTransfer(
      { event: (e) => events.push(e) },
      () =>
        exportToFile(
          {
            ...ctx,
            onPhase: (phase) => {
              assert.notEqual(phase as string, 'backup');
              if (phase === 'write')
                checkpoint = writer.exec(
                  '.timeout 0\nPRAGMA wal_checkpoint(TRUNCATE);',
                );
            },
          },
          workspace,
          destination,
          [id],
        ),
    );

    assert.equal(changed, true);
    assert.ok(summary && !('skipped' in summary) && summary.complete);
    assert.match((await checkpoint!).trim(), /^0\|0\|0$/);
    const exported = await readBundleObject(destination);

    assert.equal(exported.allComposers[0].name, 'Original');
    assert.equal(JSON.parse(exported.composers[id]).changed, undefined);
    assert.equal(JSON.parse(exported.bubbles![id][0].value).text, bubble.text);

    const resource = exported.resources!.kv.find(
      (r) => r.key === `agentKv:blob:${digest}`,
    )!;

    assert.ok(resource);
    assert.equal(await db.readKvText(conn, `agentKv:blob:${digest}`), null);

    assert.ok(
      events.some(
        (e) =>
          e.action === 'Close database read transaction' &&
          e.path === conn.database &&
          e.status === 'completed',
      ),
    );

    assert.equal(
      events.some((e) => /backup|read snapshot/i.test(e.action)),
      false,
    );

    assert.ok((await fs.stat(destination)).size < 1024 * 1024);
  },
);

test(
  'export failure closes all source sessions and leaves an existing destination intact',
  { skip },
  async (t) => {
    const { root, ctx, workspace, writer } = await fixture(t);

    const header = {
      composerId: '22222222-2222-4222-8222-222222222222',
      workspaceIdentifier: { id: 'fixture' },
    };

    await writer.exec(
      `INSERT INTO ItemTable VALUES('composer.composerHeaders',${sqlText(JSON.stringify({ allComposers: [header] }))}); INSERT INTO cursorDiskKV VALUES('composerData:22222222-2222-4222-8222-222222222222','{invalid');`,
    );

    const dest = path.join(root, 'keep.zip');

    await fs.writeFile(dest, 'previous archive');

    await assert.rejects(
      () =>
        exportToFile(ctx, workspace, dest, [
          '22222222-2222-4222-8222-222222222222',
        ]),
      /JSON/,
    );

    await writer.exec("INSERT INTO cursorDiskKV VALUES('after','error');");

    assert.match(
      (
        await writer.exec('.timeout 0\nPRAGMA wal_checkpoint(TRUNCATE);')
      ).trim(),
      /^0\|0\|0$/,
    );

    assert.equal(await fs.readFile(dest, 'utf8'), 'previous archive');
  },
);

test(
  'read request timeout closes its snapshot and allows checkpointing',
  { skip },
  async (t) => {
    const { conn, writer } = await fixture(t);
    const view = await openReadTransaction({ ...conn, timeoutMs: 200 });

    try {
      await writer.exec("INSERT INTO cursorDiskKV VALUES('during','read');");

      await assert.rejects(
        () =>
          view.conn.session!.exec(
            'WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000000000) SELECT sum(x) FROM n;',
          ),
        /timed out/,
      );
    } finally {
      await view.close();
    }

    assert.match(
      (
        await writer.exec('.timeout 0\nPRAGMA wal_checkpoint(TRUNCATE);')
      ).trim(),
      /^0\|0\|0$/,
    );
  },
);
