import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as db from '../src/db';
import * as transfer from '../src/transfer';
import * as sql from '../src/sqlite';
import { sqlText } from '../src/core';
import { readJsonFile } from '../src/format';
import type {
  TransferContext,
  WorkspaceEntry,
  WorkspaceIdentity,
} from '../src/types';
import { agentChatFixture } from './blob-fixture';

/** sqlite3 CLI used by these tests; undefined skips the suite. */
const executable = sql.findSqliteExecutable(process.env.SQLITE3_PATH);

/** Skip message when sqlite3 is not on PATH. */
const skip = executable
  ? false
  : 'sqlite3 CLI is required for dependency tests';

/** Synthetic local workspace identity. */
const identity: WorkspaceIdentity = {
  kind: 'folder',
  uri: { scheme: 'file', authority: '', path: '/synthetic' },
};

/** Composer and bubble used by the fixture chat. */
const composerId = '11111111-1111-4111-8111-111111111111';
/** Bubble id referenced from the fixture composer. */
const bubbleId = '22222222-2222-4222-8222-222222222222';

test(
  'export writes the turn closure and reports a missing todo',
  { skip },
  async (t) => {
    const chat = agentChatFixture();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cct-blob-graph-'));

    t.after(() => fs.rm(root, { recursive: true, force: true }));

    const ctx: TransferContext = {
      executable: executable as string,
      initFile: await sql.ensureInitFile(root),
      plansDir: path.join(root, 'plans'),
    };

    const dir = path.join(root, 'source');

    await fs.mkdir(dir);

    const workspace: WorkspaceEntry = {
      storageRoot: dir,
      storageId: 'source',
      key: 'source',
      mtime: 0,
      identity,
      globalDbPath: path.join(dir, 'global.vscdb'),
      workspaceDbPath: path.join(dir, 'workspace.vscdb'),
    };

    const gl = { ...ctx, database: workspace.globalDbPath };
    const ws = { ...ctx, database: workspace.workspaceDbPath };

    await sql.execSqlScript({
      ...gl,
      sql: 'CREATE TABLE ItemTable(key TEXT PRIMARY KEY,value BLOB); CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY,value BLOB);',
    });

    await sql.execSqlScript({
      ...ws,
      sql: 'CREATE TABLE ItemTable(key TEXT PRIMARY KEY,value BLOB);',
    });

    await sql.execSqlScript({
      ...gl,
      sql: db.kvInsertSql([
        {
          key: `composerData:${composerId}`,
          value: JSON.stringify({
            _v: 18,
            composerId,
            name: 'Packaging scripts',
            conversationState: chat.state,
            fullConversationHeadersOnly: [{ bubbleId }],
          }),
        },
        {
          key: `bubbleId:${composerId}:${bubbleId}`,
          value: JSON.stringify({
            _v: 3,
            composerId,
            bubbleId,
            text: 'Please look at publish_deb.sh',
          }),
        },
      ]),
    });

    for (const [id, bytes] of chat.blobs) {
      await sql.execSqlScript({
        ...gl,
        sql: `INSERT INTO cursorDiskKV VALUES (${sqlText(`agentKv:blob:${id}`)}, X'${bytes.toString('hex')}');`,
      });
    }

    await sql.execSqlScript({
      ...ws,
      sql: db.itemReplaceSql('composer.composerData', {
        allComposers: [{ composerId, name: 'Packaging scripts' }],
      }),
    });

    const dest = path.join(root, 'export.cursor-chat.zip');

    await transfer.exportToFile(ctx, workspace, dest);

    const exported = (await readJsonFile(dest)) as {
      resources: { kv: Array<{ key: string }> };
      summary: { complete: boolean };
    };

    assert.equal(exported.summary.complete, false);

    assert.deepEqual(
      exported.resources.kv
        .map((row) => row.key.slice('agentKv:blob:'.length))
        .sort(),
      [...chat.present].sort(),
    );

    assert.equal(
      exported.resources.kv.some((row) => row.key.endsWith(chat.missing)),
      false,
    );

    assert.equal(
      exported.resources.kv.some((row) => row.key.endsWith(chat.decoy)),
      false,
    );

    // Complete the fixture, then exercise the actual ZIP -> database -> repeated import path.
    await sql.execSqlScript({
      ...gl,
      sql: `INSERT INTO cursorDiskKV VALUES (${sqlText(`agentKv:blob:${chat.missing}`)}, X'746f646f');`,
    });

    const completeZip = path.join(root, 'complete.cursor-chat.zip');
    const summary = await transfer.exportToFile(ctx, workspace, completeZip);

    assert.ok('complete' in summary);
    assert.equal(summary.complete, true);
    const targetRoot = path.join(root, 'target');

    await fs.mkdir(targetRoot);

    const target: WorkspaceEntry = {
      ...workspace,
      storageRoot: targetRoot,
      storageId: 'target',
      key: 'target',
      globalDbPath: path.join(targetRoot, 'global.vscdb'),
      workspaceDbPath: path.join(targetRoot, 'workspace.vscdb'),
    };

    for (const [database, schema] of [
      [
        target.globalDbPath,
        'CREATE TABLE ItemTable(key TEXT PRIMARY KEY,value BLOB); CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY,value BLOB);',
      ],
      [
        target.workspaceDbPath,
        'CREATE TABLE ItemTable(key TEXT PRIMARY KEY,value BLOB);',
      ],
    ])
      await sql.execSqlScript({ ...ctx, database, sql: schema });
    const ticks: import('../src/types').TransferPhaseMetrics[] = [];

    const imported = await transfer.importFromBundle(
      {
        ...ctx,
        onPhase: (phase, metrics) => {
          if (phase === 'verify' && metrics?.scope === 'verifyStoredResources')
            ticks.push(metrics);
        },
      },
      completeZip,
      target,
    );

    assert.equal(imported.imported, 1);
    assert.equal(ticks[0]!.processed, 0);
    assert.equal(ticks.at(-1)!.processed, chat.present.length + 1);
    assert.equal(ticks.at(-1)!.total, chat.present.length + 1);
    assert.equal(ticks.at(-1)!.chatName, 'Packaging scripts');

    assert.equal(
      (await transfer.importFromBundle(ctx, completeZip, target)).imported,
      0,
    );

    for (const [id, bytes] of chat.blobs) {
      const stored = await db.readKvBytes(
        { ...ctx, database: target.globalDbPath },
        `agentKv:blob:${id}`,
      );

      assert.deepEqual(stored?.bytes, bytes);
    }
  },
);
