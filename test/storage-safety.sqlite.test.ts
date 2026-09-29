import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as sql from '../src/sqlite';
import * as dep from '../src/dependencies';
import * as transfer from '../src/transfer';
import type { TransferContext, WorkspaceEntry } from '../src/types';

/** Composer whose blob is contested in collision tests. */
const A = '11111111-1111-4111-8111-111111111111';
/** Blob bytes stored under `key`. */
const bytes = Buffer.from([0, 255, 128, 10, 65]);
/** SHA-256 of `bytes`. */
const digest = dep.sha256Hex(bytes);
/** `cursorDiskKV` key for the fixture blob. */
const key = `agentKv:blob:${digest}`;
/** sqlite3 CLI used by these tests; undefined skips the suite. */
const executable = sql.findSqliteExecutable(process.env.SQLITE3_PATH);
/** Skip message when sqlite3 is not on PATH. */
const skip = executable ? false : 'sqlite3 CLI is required for safety tests';

/** Format-3 export that depends on `key`. */
function payload() {
  return {
    formatVersion: 3,
    allComposers: [{ composerId: A, name: 'Fixture' }],
    composers: {
      [A]: JSON.stringify({
        _v: 18,
        composerId: A,
        conversationState:
          '~' +
          Buffer.concat([
            Buffer.from([10, 32]),
            Buffer.from(digest, 'hex'),
          ]).toString('base64'),
        fullConversationHeadersOnly: [],
      }),
    },
    bubbles: { [A]: [] },
    resources: {
      kv: [{ key, value: dep.encodeSqliteBytes(bytes, 'blob') }],
      attachments: [],
      plans: [],
    },
  };
}

/** Throwaway destination databases for safety tests. */
async function setup(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'transit-safety-'));
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
      uri: { scheme: 'file', authority: '', path: '/fixture' },
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

test(
  'resource collision after preflight must not commit composer records',
  { skip },
  async (t) => {
    const { ctx, workspace, gl } = await setup(t);
    ctx.onPhase = (phase) => {
      if (phase === 'write') {
        execFileSync(ctx.executable, [
          workspace.globalDbPath,
          `INSERT INTO cursorDiskKV VALUES ('${key}',X'99');`,
        ]);
      }
    };
    await assert.rejects(() =>
      transfer.importFromObject(ctx, payload(), workspace),
    );
    const count = await sql.execSql({
      ...gl,
      sql: "SELECT count(*) FROM cursorDiskKV WHERE key GLOB 'composerData:*';",
    });
    assert.equal(count.trim(), '0');
  },
);

test(
  'post-write verification detects changed blob bytes, not just key existence',
  { skip },
  async (t) => {
    const { ctx, workspace } = await setup(t);
    ctx.onPhase = (phase) => {
      if (phase === 'verify') {
        execFileSync(ctx.executable, [
          workspace.globalDbPath,
          `UPDATE cursorDiskKV SET value=X'99' WHERE key='${key}';`,
        ]);
      }
    };
    await assert.rejects(
      () => transfer.importFromObject(ctx, payload(), workspace),
      (err: unknown) =>
        Boolean(
          err &&
          typeof err === 'object' &&
          'code' in err &&
          err.code === 'PARTIAL',
        ),
    );
  },
);

test(
  'attachment install must not overwrite a concurrently created destination',
  { skip },
  async (t) => {
    const { workspace } = await setup(t);
    const id = '22222222-2222-4222-8222-222222222222';
    const resource = dep.encodeAttachment(
      id,
      Buffer.from('export-image'),
      'png',
    );
    const dest = path.join(
      path.dirname(workspace.workspaceDbPath),
      'images',
      `${id}.png`,
    );
    const originalLink = fs.link.bind(fs);
    let intercepted = false;
    const intercept: typeof fs.link = async (a, b) => {
      if (b === dest) {
        intercepted = true;
        await fs.writeFile(dest, 'concurrent-image');
      }
      return originalLink(a, b);
    };
    fs.link = intercept;
    let err: unknown;
    try {
      await dep.writeAttachmentFile(workspace, resource);
    } catch (e) {
      err = e;
    } finally {
      fs.link = originalLink;
    }
    assert.equal(intercepted, true);
    assert.equal(await fs.readFile(dest, 'utf8'), 'concurrent-image');
    assert.ok(err);
  },
);
