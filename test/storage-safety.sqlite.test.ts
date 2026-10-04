import { BundleWriter } from '../src/bundle-writer';
import { importFromBundle } from '../src/import-bundle';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, fork } from 'node:child_process';
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

    let planted = false;

    ctx.onPhase = (phase) => {
      // Publish reports write once before the batch, then again per batch.
      if (phase !== 'write' || planted) return;
      planted = true;

      execFileSync(
        ctx.executable,
        [
          workspace.globalDbPath,
          `INSERT INTO cursorDiskKV VALUES ('${key}',X'99');`,
        ],
        { stdio: 'pipe' },
      );
    };

    await assert.rejects(
      () => transfer.importFromObject(ctx, payload(), workspace),
      (err: unknown) =>
        Boolean(
          err &&
          typeof err === 'object' &&
          'code' in err &&
          err.code === 'RESOURCE_CONFLICT',
        ),
    );

    assert.equal(planted, true);

    const count = await sql.execSql({
      ...gl,
      sql: "SELECT count(*) FROM cursorDiskKV WHERE key GLOB 'composerData:*';",
    });

    assert.equal(count.trim(), '0');

    const plantedBytes = await sql.execSql({
      ...gl,
      sql: `SELECT hex(value) FROM cursorDiskKV WHERE key='${key}';`,
    });

    assert.equal(plantedBytes.trim(), '99');
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

/** A multi-message archive exercises the preparation loop rather than an empty chat. */
async function messageArchive(dir: string, count = 250): Promise<string> {
  const file = path.join(dir, 'messages.zip');
  const writer = await BundleWriter.open(file);

  await writer.beginChat({ composerId: A, name: 'Lock regression' });
  await writer.writeComposer({ _v: 18, composerId: A }, 'absent');

  for (let index = 0; index < count; index++) {
    const id = `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, '0')}`;

    await writer.writeBubble(id, {
      composerId: A,
      bubbleId: id,
      text: 'fixture '.repeat(100),
    });
  }

  await writer.endChat();
  await writer.finish();

  return file;
}

test(
  'another writer succeeds while import prepares messages; cancellation leaves no global rows',
  { skip },
  async (t) => {
    const { ctx, workspace, gl } = await setup(t);
    const file = await messageArchive(workspace.storageRoot);
    const controller = new AbortController();

    ctx.signal = controller.signal;
    let checked = false;

    ctx.onPhase = (phase, metrics) => {
      if (phase === 'prepare' && metrics?.processed === 100) {
        execFileSync(ctx.executable, [
          workspace.globalDbPath,
          '.timeout 0',
          "INSERT INTO ItemTable VALUES('other-window','working');",
        ]);

        checked = true;
        controller.abort();
      }
    };

    await assert.rejects(() => importFromBundle(ctx, file, workspace));
    assert.equal(checked, true);

    assert.equal(
      (
        await sql.execSql({
          ...gl,
          sql: "SELECT count(*) FROM cursorDiskKV WHERE key LIKE 'composerData:%';",
          readOnly: true,
        })
      ).trim(),
      '0',
    );

    execFileSync(ctx.executable, [
      workspace.globalDbPath,
      '.timeout 0',
      "BEGIN IMMEDIATE; UPDATE ItemTable SET value='still working' WHERE key='other-window'; COMMIT;",
    ]);

    const retry = await importFromBundle(
      { ...ctx, signal: undefined, onPhase: undefined },
      file,
      workspace,
    );

    assert.equal(retry.imported, 1);
  },
);

test(
  'worker loses IPC during preparation, exits and releases all SQLite writers',
  { skip, timeout: 20000 },
  async (t) => {
    const { ctx, workspace } = await setup(t);
    const file = await messageArchive(workspace.storageRoot);

    const child = fork(path.resolve('src/transfer-worker.ts'), [], {
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });

    t.after(async () => {
      if (child.exitCode === null) child.kill('SIGKILL');
    });

    let disconnected = false;

    const exited = new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', () => resolve());
    });

    child.on(
      'message',
      (message: {
        type?: string;
        phase?: string;
        metrics?: { processed?: number };
      }) => {
        if (
          !disconnected &&
          message.type === 'phase' &&
          message.phase === 'prepare' &&
          message.metrics?.processed === 100
        ) {
          disconnected = true;
          child.disconnect();
        }
      },
    );

    child.send({
      type: 'start',
      job: {
        kind: 'import',
        executable: ctx.executable,
        initFile: ctx.initFile,
        workspace,
        filePath: file,
      },
    });

    await exited;
    assert.equal(disconnected, true);

    execFileSync(ctx.executable, [
      workspace.globalDbPath,
      '.timeout 0',
      "BEGIN IMMEDIATE; INSERT INTO ItemTable VALUES('after-disconnect','ok'); COMMIT;",
    ]);

    await importFromBundle(ctx, file, workspace);
  },
);

test(
  'cancel after a committed batch keeps the chat hidden and retry removes only its verified messages',
  { skip },
  async (t) => {
    const { ctx, workspace, gl } = await setup(t);
    const file = await messageArchive(workspace.storageRoot);
    const controller = new AbortController();
    let checked = false;

    ctx.signal = controller.signal;

    ctx.onPhase = (phase, metrics) => {
      if (phase === 'write' && metrics?.processed && !checked) {
        checked = true;

        execFileSync(ctx.executable, [
          workspace.globalDbPath,
          '.timeout 0',
          "INSERT INTO ItemTable VALUES('between-batches','ok');",
        ]);

        controller.abort();
      }
    };

    await assert.rejects(
      () => importFromBundle(ctx, file, workspace),
      (error: unknown) =>
        Boolean(
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'PARTIAL',
        ),
    );

    assert.equal(checked, true);

    assert.equal(
      (
        await sql.execSql({
          ...gl,
          readOnly: true,
          sql: "SELECT count(*) FROM cursorDiskKV WHERE key LIKE 'composerData:%';",
        })
      ).trim(),
      '0',
    );

    assert.ok(
      Number(
        (
          await sql.execSql({
            ...gl,
            readOnly: true,
            sql: "SELECT count(*) FROM cursorDiskKV WHERE key LIKE 'bubbleId:%';",
          })
        ).trim(),
      ) > 0,
    );

    const result = await importFromBundle(
      { ...ctx, signal: undefined, onPhase: undefined },
      file,
      workspace,
    );

    assert.equal(result.imported, 1);

    assert.equal(
      (
        await sql.execSql({
          ...gl,
          readOnly: true,
          sql: "SELECT count(*) FROM cursorDiskKV WHERE key LIKE 'bubbleId:%';",
        })
      ).trim(),
      '250',
    );
  },
);

test(
  'recovery preserves an unfinished message changed by another writer',
  { skip },
  async (t) => {
    const { ctx, workspace, gl } = await setup(t);
    const file = await messageArchive(workspace.storageRoot);
    const controller = new AbortController();

    ctx.signal = controller.signal;

    ctx.onPhase = (phase, metrics) => {
      if (phase === 'write' && metrics?.processed) controller.abort();
    };

    await assert.rejects(() => importFromBundle(ctx, file, workspace));

    await sql.execSql({
      ...gl,
      readOnly: false,
      sql: "UPDATE cursorDiskKV SET value='changed by another writer' WHERE key=(SELECT key FROM cursorDiskKV WHERE key LIKE 'bubbleId:%' ORDER BY key LIMIT 1);",
    });

    await assert.rejects(
      () =>
        importFromBundle(
          { ...ctx, signal: undefined, onPhase: undefined },
          file,
          workspace,
        ),
      (error: unknown) =>
        Boolean(
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'NEEDS_ATTENTION',
        ),
    );

    assert.equal(
      (
        await sql.execSql({
          ...gl,
          readOnly: true,
          sql: "SELECT count(*) FROM cursorDiskKV WHERE value='changed by another writer';",
        })
      ).trim(),
      '1',
    );
  },
);

test(
  'v4 import remaps nested bubble references without replacing message text',
  { skip },
  async (t) => {
    const { ctx, workspace, gl } = await setup(t);
    const file = path.join(workspace.storageRoot, 'nested.zip');
    const bubble = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const writer = await BundleWriter.open(file);

    await writer.beginChat({ composerId: A, name: 'Nested references' });

    await writer.writeComposer(
      {
        _v: 18,
        composerId: A,
        conversationMap: { [bubble]: { bubbleId: bubble } },
        originalFileStates: {
          'file:///fixture': { firstEditBubbleId: bubble },
        },
      },
      'ndjson',
    );

    await writer.writeConversation({ bubbleId: bubble });

    await writer.writeBubble(bubble, {
      bubbleId: bubble,
      composerId: A,
      text: bubble,
    });

    await writer.endChat();
    await writer.finish();
    const result = await importFromBundle(ctx, file, workspace);
    const target = result.composerIds[0];

    const value = (
      await sql.execSql({
        ...gl,
        readOnly: true,
        sql: `SELECT value FROM cursorDiskKV WHERE key='composerData:${target}';`,
      })
    ).trim();

    const body = JSON.parse(value);
    const mapped = body.fullConversationHeadersOnly[0].bubbleId;

    assert.notEqual(mapped, bubble);
    assert.equal(body.conversationMap[mapped].bubbleId, mapped);

    assert.equal(
      body.originalFileStates['file:///fixture'].firstEditBubbleId,
      mapped,
    );

    const importedBubble = JSON.parse(
      (
        await sql.execSql({
          ...gl,
          readOnly: true,
          sql: `SELECT value FROM cursorDiskKV WHERE key='bubbleId:${target}:${mapped}';`,
        })
      ).trim(),
    );

    assert.equal(importedBubble.text, bubble);
  },
);

test(
  'retry after cancelling a later chat keeps the earlier verified chat and completes the rest',
  { skip },
  async (t) => {
    const { ctx, workspace, gl } = await setup(t);
    const file = path.join(workspace.storageRoot, 'two.zip');
    const writer = await BundleWriter.open(file);

    for (const composer of [A, '22222222-2222-4222-8222-222222222222']) {
      await writer.beginChat({ composerId: composer, name: composer });
      await writer.writeComposer({ _v: 18, composerId: composer }, 'absent');

      for (let index = 0; index < 130; index++) {
        const bubble = `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, '0')}`;

        await writer.writeBubble(bubble, {
          composerId: composer,
          bubbleId: bubble,
          text: 'hello',
        });
      }

      await writer.endChat();
    }

    await writer.finish();
    const controller = new AbortController();

    ctx.signal = controller.signal;

    ctx.onPhase = (phase, metrics) => {
      if (phase === 'write' && metrics?.chatIndex === 2 && metrics.processed)
        controller.abort();
    };

    await assert.rejects(() => importFromBundle(ctx, file, workspace));

    const result = await importFromBundle(
      { ...ctx, signal: undefined, onPhase: undefined },
      file,
      workspace,
    );

    assert.equal(result.imported, 1);
    assert.equal(result.alreadyImported, 1);

    assert.equal(
      (
        await sql.execSql({
          ...gl,
          readOnly: true,
          sql: "SELECT count(*) FROM cursorDiskKV WHERE key LIKE 'composerData:%';",
        })
      ).trim(),
      '2',
    );

    assert.equal(
      (
        await sql.execSql({
          ...gl,
          readOnly: true,
          sql: "SELECT count(*) FROM cursorDiskKV WHERE key LIKE 'bubbleId:%';",
        })
      ).trim(),
      '260',
    );
  },
);
