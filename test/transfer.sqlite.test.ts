import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as db from '../src/db';
import * as transfer from '../src/transfer';
import * as sql from '../src/sqlite';
import type {
  TransferContext,
  WorkspaceEntry,
  WorkspaceIdentity,
} from '../src/types';

/** Composer transferred in these schema tests. */
const A = '11111111-1111-4111-8111-111111111111';
/** Nested bubble id X. */
const X = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
/** Nested bubble id Y. */
const Y = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
/** sqlite3 CLI used by these tests; undefined skips the suite. */
const executable = sql.findSqliteExecutable(process.env.SQLITE3_PATH);
/** Skip message when sqlite3 is not on PATH. */
const skip = executable ? false : 'sqlite3 CLI is required for transfer tests';

/** SSH workspace identity used as the transfer target. */
const identity: WorkspaceIdentity = {
  kind: 'folder',
  uri: {
    scheme: 'vscode-remote',
    authority: 'ssh-remote+host-a',
    path: '/repo',
    query: '',
    fragment: '',
  },
};

/** Composer header bound to `identity`. */
const header = {
  composerId: A,
  name: 'Synthetic',
  workspaceIdentifier: { id: 'fixture', uri: identity.uri },
};

/** Format-2 export whose composer JSON points at bubbles X and Y. */
function payload(ids = [A]) {
  return {
    formatVersion: 2,
    allComposers: ids.map((composerId) => ({
      composerId,
      name: 'Synthetic fixture',
      createdAt: 7,
      lastUpdatedAt: 9,
    })),
    composers: Object.fromEntries(
      ids.map((id) => [
        id,
        JSON.stringify({
          composerId: id,
          fullConversationHeadersByBubbleId: {
            [X]: { bubbleId: X },
            [Y]: { bubbleId: Y },
          },
        }),
      ]),
    ),
    bubbles: Object.fromEntries(
      ids.map((id) => [
        id,
        [X, Y].map((bubbleId, i) => ({
          key: `bubbleId:${id}:${bubbleId}`,
          bubbleId,
          value: JSON.stringify({
            composerId: id,
            bubbleId,
            ...(i === 0 ? { nextBubbleId: Y } : { previousBubbleId: X }),
          }),
        })),
      ]),
    ),
  };
}

/** Throwaway databases, optionally with extra columns or a blocked schema. */
async function fixture(
  t: { after: (fn: () => Promise<void>) => void },
  opts: { globalExtra?: string; workspaceSchema?: string } = {},
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cct-transfer-'));

  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const ctx: TransferContext = {
    executable: executable as string,
    initFile: await sql.ensureInitFile(dir),
  };

  const workspace: WorkspaceEntry = {
    storageRoot: dir,
    storageId: 'fixture',
    identity,
    globalDbPath: path.join(dir, 'global.vscdb'),
    workspaceDbPath: path.join(dir, 'workspace.vscdb'),
    mtime: 0,
    key: 'fixture',
  };

  const gl = { ...ctx, database: workspace.globalDbPath };
  const ws = { ...ctx, database: workspace.workspaceDbPath };

  await sql.execSqlScript({
    ...gl,
    sql: `PRAGMA journal_mode=WAL;
CREATE TABLE ItemTable(key TEXT PRIMARY KEY,value BLOB);
CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY,value BLOB);
INSERT INTO ItemTable VALUES('composer.composerHeaders','{"allComposers":[]}');
${opts.globalExtra || ''}`,
  });

  await sql.execSqlScript({
    ...ws,
    sql: `PRAGMA journal_mode=WAL; ${
      opts.workspaceSchema ||
      'CREATE TABLE ItemTable(key TEXT PRIMARY KEY,value BLOB);'
    }`,
  });

  return { dir, ctx, workspace, gl, ws };
}

test(
  'dot-command quoting preserves this OS path, including backslashes',
  { skip },
  async (t) => {
    const { dir, gl } = await fixture(t);

    const dest =
      process.platform === 'win32'
        ? path.join(dir, 'backup-dir', 'new.vscdb')
        : path.join(dir, String.raw`backup\new.vscdb`);

    if (process.platform === 'win32') {
      await fs.mkdir(path.dirname(dest), { recursive: true });
    }

    await sql.backupDatabase({ ...gl, dest });
    assert.ok((await fs.stat(dest)).size > 0);
  },
);

test(
  'backup supports an apostrophe in its destination directory',
  { skip },
  async (t) => {
    const { dir, gl } = await fixture(t);
    const destDir = path.join(dir, "O'Brien");

    await fs.mkdir(destDir);
    const dest = path.join(destDir, 'backup.vscdb');

    await sql.backupDatabase({ ...gl, dest });
    assert.ok((await fs.stat(dest)).size > 0);
  },
);

test(
  'unsupported workspace constraint is rejected before global writes',
  { skip },
  async (t) => {
    const { ctx, workspace, gl } = await fixture(t, {
      workspaceSchema:
        'CREATE TABLE ItemTable(key TEXT PRIMARY KEY,value BLOB,requiredExtra TEXT NOT NULL);',
    });

    await assert.rejects(transfer.importFromObject(ctx, payload(), workspace));

    const count = await sql.execSql({
      ...gl,
      sql: "SELECT count(*) FROM cursorDiskKV WHERE key GLOB 'composerData:*';",
    });

    assert.equal(count.trim(), '0');
  },
);

test(
  'malformed bubble JSON is rejected instead of imported as success',
  { skip },
  async (t) => {
    const { ctx, workspace } = await fixture(t);
    const obj = payload();

    obj.bubbles[A][0].value = '{"broken"';
    await assert.rejects(transfer.importFromObject(ctx, obj, workspace));
  },
);

test(
  'concurrent workspace metadata update is preserved',
  { skip },
  async (t) => {
    const { ctx, workspace, ws } = await fixture(t);

    await sql.execSqlScript({
      ...ws,
      sql: db.itemReplaceSql('composer.composerData', {
        selectedComposerIds: [],
      }),
    });

    const original = db.readItemTextImpl;
    let injected = false;

    db.testHooks.readItemText = async (conn, key) => {
      const old = await original(conn, key);

      if (
        !injected &&
        conn.database === ws.database &&
        key === 'composer.composerData'
      ) {
        injected = true;
        const parsed = old ? JSON.parse(old) : {};

        await sql.execSqlScript({
          ...ws,
          sql: db.itemReplaceSql(key, { ...parsed, concurrentMarker: true }),
        });
      }

      return old;
    };

    try {
      await transfer.importFromObject(ctx, payload(), workspace);
    } finally {
      delete db.testHooks.readItemText;
    }

    const stored = JSON.parse(
      (await original(ws, 'composer.composerData')) || '{}',
    ) as { concurrentMarker?: boolean };

    assert.equal(stored.concurrentMarker, true);
  },
);

test(
  'missing body during export must not produce complete=true',
  { skip },
  async (t) => {
    const { dir, ctx, workspace, gl, ws } = await fixture(t);

    await sql.execSqlScript({
      ...gl,
      sql: db.kvInsertSql([
        { key: `composerData:${A}`, value: JSON.stringify({ composerId: A }) },
      ]),
    });

    await sql.execSqlScript({
      ...ws,
      sql: db.itemReplaceSql('composer.composerData', {
        allComposers: [header],
      }),
    });

    const original = db.readKvTextImpl;
    let injected = false;

    db.testHooks.readKvText = async (conn, key) => {
      const body = await original(conn, key);

      if (body !== null && !injected && key.startsWith('composerData:')) {
        injected = true;
        await sql.execSqlScript({ ...gl, sql: 'DELETE FROM cursorDiskKV;' });

        return null;
      }

      return body;
    };

    let result:
      { skipped: true; reason: string } | { complete: boolean } | undefined;

    try {
      result = await transfer.exportToFile(
        ctx,
        workspace,
        path.join(dir, 'export.json'),
      );
    } catch {
      return;
    } finally {
      delete db.testHooks.readKvText;
    }

    assert.equal(result && 'complete' in result && result.complete, false);
  },
);

test(
  'a successful legacy import is discoverable through its own resolver',
  { skip },
  async (t) => {
    const { ctx, workspace, gl, ws } = await fixture(t);
    const result = await transfer.importFromObject(ctx, payload(), workspace);

    assert.equal(result.imported, 1);
    const glInfo = await db.inspectDatabase(gl);
    const wsInfo = await db.inspectDatabase(ws);

    const headers = await db.resolveComposers(ws, gl, {
      storageId: workspace.storageId,
      identity,
      layoutWs: wsInfo.layout,
      layoutGl: glInfo.layout,
    });

    assert.equal(headers.length, 1);
  },
);

test(
  'unsupported header constraints must not leave committed composer bodies',
  { skip },
  async (t) => {
    const { ctx, workspace, gl } = await fixture(t, {
      globalExtra:
        'CREATE TABLE composerHeaders(composerId TEXT PRIMARY KEY,workspaceId TEXT,value BLOB,mustFill TEXT NOT NULL);',
    });

    await assert.rejects(transfer.importFromObject(ctx, payload(), workspace));

    const count = await sql.execSql({
      ...gl,
      sql: "SELECT count(*) FROM cursorDiskKV WHERE key GLOB 'composerData:*';",
    });

    assert.equal(count.trim(), '0');
  },
);

test(
  'an unsupported workspace is rejected before global mutation',
  { skip },
  async (t) => {
    const { ctx, workspace } = await fixture(t, {
      workspaceSchema: 'CREATE TABLE UnknownWorkspace(foo TEXT);',
    });

    await assert.rejects(transfer.importFromObject(ctx, payload(), workspace));
  },
);

test(
  'imported ordered headers resolve to stored bubbles',
  { skip },
  async (t) => {
    const { ctx, workspace, gl } = await fixture(t);

    const obj = {
      formatVersion: 2,
      allComposers: [{ composerId: A, name: 'Fixture' }],
      composers: {
        [A]: JSON.stringify({
          _v: 18,
          composerId: A,
          name: 'Fixture',
          fullConversationHeadersOnly: [
            { bubbleId: X, type: 1, serverBubbleId: X },
          ],
        }),
      },
      bubbles: {
        [A]: [
          {
            key: `bubbleId:${A}:${X}`,
            bubbleId: X,
            value: JSON.stringify({
              _v: 3,
              bubbleId: X,
              text: 'hello',
              serverBubbleId: X,
            }),
          },
        ],
      },
    };

    const result = await transfer.importFromObject(ctx, obj, workspace);
    const newId = result.composerIds[0];
    const conn = { ...gl, readOnly: true };

    const body = JSON.parse(
      (await db.readKvText(conn, `composerData:${newId}`)) || '{}',
    ) as {
      name?: string;
      fullConversationHeadersOnly: Array<{
        bubbleId: string;
        serverBubbleId: string;
      }>;
    };

    const ids = await db.listBubbleIds(conn, newId);

    assert.equal(
      body.fullConversationHeadersOnly.filter((h) => !ids.has(h.bubbleId))
        .length,
      0,
    );

    assert.equal(body.fullConversationHeadersOnly[0].serverBubbleId, X);
    assert.equal(body.name, 'Fixture');
  },
);

test(
  'exhausted global CAS keeps a partially staged chat unpublished',
  { skip },
  async (t) => {
    const { ctx, workspace, gl } = await fixture(t);
    const original = db.readItemTextImpl;
    let injected = 0;

    db.testHooks.readItemText = async (conn, key) => {
      const raw = await original(conn, key);

      if (conn.database === gl.database && key === 'composer.composerHeaders') {
        injected++;

        await sql.execSqlScript({
          ...gl,
          sql: db.itemReplaceSql(key, {
            ...JSON.parse(raw || '{}'),
            concurrentMarker: injected,
          }),
        });
      }

      return raw;
    };

    try {
      await assert.rejects(
        transfer.importFromObject(ctx, payload(), workspace),
        (error: unknown) =>
          Boolean(
            error &&
            typeof error === 'object' &&
            'code' in error &&
            error.code === 'PARTIAL',
          ),
      );
    } finally {
      delete db.testHooks.readItemText;
    }

    assert.equal(injected, 5);

    const count = await sql.execSql({
      ...gl,
      sql: "SELECT count(*) FROM cursorDiskKV WHERE key GLOB 'composerData:*';",
    });

    assert.equal(count.trim(), '0');
    const retry = await transfer.importFromObject(ctx, payload(), workspace);

    assert.equal(retry.imported, 1);
  },
);

test(
  'partial recovery skips scalar bubble JSON without losing a valid chat',
  { skip },
  async (t) => {
    const { ctx, workspace } = await fixture(t);
    const brokenId = '22222222-2222-4222-8222-222222222222';
    const obj = payload([A, brokenId]);

    obj.bubbles[brokenId]![0]!.value = 'null';

    const result = await transfer.importFromObject(ctx, obj, workspace, {
      allowPartial: true,
    });

    assert.equal(result.imported, 1);
    assert.equal(result.skipped, 1);
    assert.equal(result.skippedChats[0]?.composerId, brokenId);
  },
);
