import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as db from '../src/db';
import * as sql from '../src/sqlite';
import * as transfer from '../src/transfer';
import { TransferError } from '../src/types';
import type {
  ExportObject,
  TransferContext,
  WorkspaceEntry,
} from '../src/types';

/** Complete chat in mixed-export fixtures. */
const A = '11111111-1111-4111-8111-111111111111';
/** Bubble belonging to the complete chat. */
const B = '22222222-2222-4222-8222-222222222222';
/** History-only chat missing a blob. */
const C = '33333333-3333-4333-8333-333333333333';
/** Unusable chat in mixed-export fixtures. */
const D = '44444444-4444-4444-8444-444444444444';
/** sqlite3 CLI used by these tests; undefined skips the suite. */
const executable = sql.findSqliteExecutable(process.env.SQLITE3_PATH);
/** Skip message when sqlite3 is not on PATH. */
const skip = executable ? false : 'sqlite3 CLI is required for recovery tests';

/** SHA-256 of bytes that are deliberately absent from storage. */
const digest = createHash('sha256').update('missing').digest('hex');
/** conversationState that names the missing blob. */
const state =
  '~' +
  Buffer.concat([
    Buffer.from([0x0a, 0x20]),
    Buffer.from(digest, 'hex'),
  ]).toString('base64');

/** Throwaway destination databases for recovery imports. */
async function setup(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cct-recovery-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const ctx: TransferContext = {
    executable: executable as string,
    initFile: await sql.ensureInitFile(dir),
  };
  const workspace: WorkspaceEntry = {
    storageRoot: dir,
    storageId: 'target',
    key: 'target',
    mtime: 0,
    identity: {
      kind: 'folder',
      uri: { scheme: 'file', authority: '', path: '/recovery' },
    },
    globalDbPath: path.join(dir, 'global.vscdb'),
    workspaceDbPath: path.join(dir, 'workspace.vscdb'),
  };
  const gl = { ...ctx, database: workspace.globalDbPath };
  const ws = { ...ctx, database: workspace.workspaceDbPath };
  await sql.execSqlScript({
    ...gl,
    sql: `PRAGMA journal_mode=WAL;
CREATE TABLE ItemTable(key TEXT PRIMARY KEY,value BLOB);
CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY,value BLOB);
INSERT INTO ItemTable VALUES('composer.composerHeaders','{"allComposers":[]}');`,
  });
  await sql.execSqlScript({
    ...ws,
    sql: 'PRAGMA journal_mode=WAL; CREATE TABLE ItemTable(key TEXT PRIMARY KEY,value BLOB);',
  });
  return { ctx, workspace, gl };
}

/** Mixed complete and history-only export used by recovery tests. */
function mixedExport(): ExportObject {
  return {
    formatVersion: 3,
    allComposers: [
      { composerId: A, name: 'Complete' },
      { composerId: C, name: 'History only' },
    ],
    composers: {
      [A]: JSON.stringify({
        _v: 18,
        composerId: A,
        name: 'Complete',
        fullConversationHeadersOnly: [{ bubbleId: B }],
      }),
      [C]: JSON.stringify({
        _v: 18,
        composerId: C,
        name: 'History only',
        conversationState: state,
        fullConversationHeadersOnly: [{ bubbleId: D }],
      }),
    },
    bubbles: {
      [A]: [
        {
          key: `bubbleId:${A}:${B}`,
          bubbleId: B,
          value: JSON.stringify({
            _v: 3,
            composerId: A,
            bubbleId: B,
            text: 'ok',
          }),
        },
      ],
      [C]: [
        {
          key: `bubbleId:${C}:${D}`,
          bubbleId: D,
          value: JSON.stringify({
            _v: 3,
            composerId: C,
            bubbleId: D,
            text: 'history',
          }),
        },
      ],
    },
    resources: { kv: [], attachments: [], plans: [] },
  };
}

test(
  'strict import still refuses a mixed complete/incomplete file',
  { skip },
  async (t) => {
    const { ctx, workspace, gl } = await setup(t);
    await assert.rejects(
      () => transfer.importFromObject(ctx, mixedExport(), workspace),
      (err: unknown) =>
        err instanceof TransferError && err.code === 'MISSING_DEPENDENCY',
    );
    const count = await sql.execSql({
      ...gl,
      sql: "SELECT count(*) FROM cursorDiskKV WHERE key GLOB 'composerData:*';",
    });
    assert.equal(count.trim(), '0');
  },
);

test(
  'allowPartial imports complete chats and history-only separately',
  { skip },
  async (t) => {
    const { ctx, workspace, gl } = await setup(t);
    const result = await transfer.importFromObject(
      ctx,
      mixedExport(),
      workspace,
      { allowPartial: true },
    );
    assert.equal(result.complete, 1);
    assert.equal(result.historyOnly, 1);
    assert.equal(result.skipped, 0);
    assert.equal(result.imported, 2);
    const names = [];
    for (const id of result.composerIds) {
      const body = JSON.parse(
        (await db.readKvText(gl, `composerData:${id}`)) || '{}',
      ) as { name?: string };
      names.push(body.name);
    }
    assert.deepEqual(names.sort(), ['Complete', 'History only']);
  },
);

test(
  'allowPartial does not treat a wholly unusable file as a zero-chat success',
  { skip },
  async (t) => {
    const { ctx, workspace, gl } = await setup(t);
    await assert.rejects(
      () =>
        transfer.importFromObject(
          ctx,
          {
            formatVersion: 3,
            allComposers: [{ composerId: A, name: 'Broken' }],
            composers: { [A]: '{not-json' },
            bubbles: { [A]: [] },
            resources: { kv: [], attachments: [], plans: [] },
          },
          workspace,
          { allowPartial: true },
        ),
      (err: unknown) =>
        err instanceof TransferError && err.code === 'NOTHING_TO_IMPORT',
    );
    const count = await sql.execSql({
      ...gl,
      sql: "SELECT count(*) FROM cursorDiskKV WHERE key GLOB 'composerData:*';",
    });
    assert.equal(count.trim(), '0');
  },
);

test(
  'allowPartial still rejects a forbidden resource key',
  { skip },
  async (t) => {
    const { ctx, workspace } = await setup(t);
    const obj = mixedExport();
    obj.resources = {
      kv: [
        {
          key: 'agentKv:other:00',
          value: {
            storageClass: 'blob',
            base64: Buffer.from('x').toString('base64'),
            byteLength: 1,
            sha256: createHash('sha256').update('x').digest('hex'),
          },
        },
      ],
      attachments: [],
      plans: [],
    };
    await assert.rejects(
      () =>
        transfer.importFromObject(ctx, obj, workspace, { allowPartial: true }),
      /not allowed/i,
    );
  },
);
