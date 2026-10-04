import { SqliteSession } from '../src/sqlite-session';
import { runTransfer } from '../src/transfer-process';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MAX_SQLITE_VALUE_BYTES } from '../src/bundle-limits';
import { deleteSelectedChats } from '../src/chat-deletion';
import { deleteHeaderReferences, deleteMessageRows } from '../src/deletion-sql';
import {
  findSqliteExecutable,
  ensureInitFile,
  execSql,
  execSqlScript,
} from '../src/sqlite';
import { sqlText } from '../src/core';
import type { Layout, WorkspaceEntry, TransferContext } from '../src/types';

/** Real SQLite fixtures never point at user storage. */
const executable = findSqliteExecutable(process.env.SQLITE3_PATH);
/** Integration tests require the same CLI used by production. */
const skip = executable ? false : 'sqlite3 required';

/**
 * Remove a fixture directory.
 * Node's recursive `maxRetries` retries the directory and every child, so one
 * locked file costs about 20s and still fails. Retry the whole tree ourselves.
 */
async function removeTemp(target: string): Promise<void> {
  const deadline = Date.now() + 2000;
  let delay = 50;

  for (;;) {
    try {
      await fs.rm(target, { recursive: true, force: true });

      return;
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? error.code
          : undefined;

      if (
        (code !== 'EBUSY' && code !== 'EPERM' && code !== 'ENOTEMPTY') ||
        Date.now() >= deadline
      ) {
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 200);
    }
  }
}

/** Two workspaces share one global DB and one shared chat. */
async function setup(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cct-delete-'));

  t.after(() => removeTemp(root));

  const ctx: TransferContext = {
    executable: executable!,
    initFile: await ensureInitFile(root),
  };

  const globalDbPath = path.join(root, 'global.vscdb');
  const entries: WorkspaceEntry[] = [];

  for (const storageId of ['one', 'two']) {
    const directory = path.join(root, 'workspaceStorage', storageId);

    await fs.mkdir(directory, { recursive: true });
    const workspaceDbPath = path.join(directory, 'state.vscdb');

    const entry: WorkspaceEntry = {
      storageRoot: root,
      storageId,
      key: storageId,
      mtime: 0,
      globalDbPath,
      workspaceDbPath,
      identity: {
        kind: 'folder',
        uri: { scheme: 'file', authority: '', path: `/${storageId}` },
      },
    };

    entries.push(entry);

    const ids =
      storageId === 'one'
        ? [
            '11111111-1111-4111-8111-111111111111',
            '22222222-2222-4222-8222-222222222222',
          ]
        : [
            '33333333-3333-4333-8333-333333333333',
            '22222222-2222-4222-8222-222222222222',
          ];

    await execSqlScript({
      ...ctx,
      database: workspaceDbPath,
      sql: `PRAGMA journal_mode=WAL; CREATE TABLE ItemTable(key TEXT PRIMARY KEY,value BLOB); INSERT INTO ItemTable VALUES ('composer.composerData',${sqlText(JSON.stringify({ allComposers: ids.map((composerId) => ({ composerId })), selectedComposerIds: ids, lastFocusedComposerIds: ids }))}),('unrelated','KEEP');`,
    });
  }

  await execSqlScript({
    ...ctx,
    database: globalDbPath,
    sql: `PRAGMA journal_mode=WAL; CREATE TABLE ItemTable(key TEXT PRIMARY KEY,value BLOB); CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY,value BLOB); INSERT INTO ItemTable VALUES('composer.composerHeaders',${sqlText(
      JSON.stringify({
        allComposers: [
          {
            composerId: '11111111-1111-4111-8111-111111111111',
            workspaceIdentifier: { id: 'one' },
          },
          {
            composerId: '33333333-3333-4333-8333-333333333333',
            workspaceIdentifier: { id: 'two' },
          },
        ],
      }),
    )}); INSERT INTO cursorDiskKV VALUES ('composerData:11111111-1111-4111-8111-111111111111','{}'),('bubbleId:11111111-1111-4111-8111-111111111111:message','{}'),('composerData:22222222-2222-4222-8222-222222222222','{}'),('composerData:33333333-3333-4333-8333-333333333333','{}'),('agentKv:22222222-2222-4222-8222-222222222222:blob','KEEP');`,
  });

  const read = (database: string, query: string) =>
    execSql({ ...ctx, database, sql: query });

  const dump = async () =>
    Promise.all([
      read(globalDbPath, 'SELECT key,value FROM cursorDiskKV ORDER BY key;'),
      ...entries.map((entry) =>
        read(
          entry.workspaceDbPath,
          'SELECT key,value FROM ItemTable ORDER BY key;',
        ),
      ),
      read(globalDbPath, 'SELECT key,value FROM ItemTable ORDER BY key;'),
    ]);

  return { root, ctx, entries, globalDbPath, read, dump };
}

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const D = '44444444-4444-4444-8444-444444444444';
const E = '55555555-5555-4555-8555-555555555555';

/** Layout passed straight into the header writer. */
function writerLayout(
  /** When true, the writer also deletes composerHeaders rows. */
  composerHeaders: boolean,
): Layout {
  return {
    itemTable: true,
    cursorDiskKV: true,
    composerHeaders,
    headerColumns: composerHeaders ? ['composerId', 'value'] : [],
    canWriteGlobal: true,
    canWriteWorkspace: true,
    writeBlocked: false,
    unsupportedReason: null,
  };
}

/** Open a main database and an attached workspace database for writer tests. */
async function writerFixture(
  /** Registers cleanup. */
  t: { after: (fn: () => Promise<void>) => void },
  /** SQL applied to both databases after the shared tables exist. */
  sql = '',
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cct-delete-sql-'));
  const cleanup: { session?: SqliteSession } = {};

  // after hooks run in registration order and stop at the first rejection.
  t.after(async () => {
    try {
      await cleanup.session?.close();
    } finally {
      await removeTemp(root);
    }
  });

  const ctx: TransferContext = {
    executable: executable!,
    initFile: await ensureInitFile(root),
  };

  const database = path.join(root, 'global.vscdb');
  const workspaceDb = path.join(root, 'workspace.vscdb');

  const tables = `PRAGMA journal_mode=WAL;
CREATE TABLE ItemTable(key TEXT PRIMARY KEY, value BLOB);
CREATE TABLE composerHeaders(composerId TEXT PRIMARY KEY, value BLOB);
CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY, value BLOB);`;

  await execSqlScript({ ...ctx, database, sql: `${tables}\n${sql}` });

  await execSqlScript({
    ...ctx,
    database: workspaceDb,
    sql: `${tables}\n${sql}`,
  });

  const session = await SqliteSession.open({
    ...ctx,
    database,
    maxLineBytes: 2 * MAX_SQLITE_VALUE_BYTES + 65536,
  });

  cleanup.session = session;

  await session.exec(
    `ATTACH DATABASE ${sqlText(workspaceDb)} AS workspace;
CREATE TEMP TABLE selected(id TEXT PRIMARY KEY);`,
  );

  return { ctx, database, workspaceDb, session };
}

/** Read one ItemTable value back through the open writer session. */
async function storedText(
  /** Open SQLite session. */
  session: SqliteSession,
  /** Attached schema that holds the list. */
  schema: 'main' | 'workspace',
  /** ItemTable key. */
  key: string,
) {
  const hex = (
    await session.exec(
      `SELECT coalesce(hex(value),'') FROM ${schema}.ItemTable WHERE key=${sqlText(key)};`,
    )
  ).trim();

  return Buffer.from(hex, 'hex').toString('utf8');
}

/**
 * One migrated workspace plus optional extra windows on the same global table.
 * Chat rows live in composerHeaders; the workspace item is flags unless omitted.
 */
async function liveWorkspace(
  /** Registers cleanup. */
  t: { after: (fn: () => Promise<void>) => void },
  /** Fixture shape. */
  spec: {
    /** Workspace composer.composerData object. Omit the key when undefined and includeComposerData is false. */
    composerData?: unknown;
    /** When false, composer.composerData is absent. Defaults to true. */
    includeComposerData?: boolean;
    /** Composer ids stored in the workspace composerHeaders table. */
    localHeaderIds?: string[];
    /** When false, the workspace has no composerHeaders table. */
    localHeaderTable?: boolean;
    /** Global composerHeaders rows. */
    globalHeaders?: Array<{
      /** Composer id. */
      composerId: string;
      /** workspaceIdentifier.id and workspaceId column. */
      storageId: string;
    }>;
    /** cursorDiskKV keys with an empty object payload. */
    keys?: string[];
    /** Extra nullable column on the global composerHeaders table. */
    headerExtraColumn?: string;
    /** Global composer.composerHeaders JSON, when the legacy blob is also present. */
    globalBlob?: unknown;
    /** Additional workspace folders that share the global database. */
    extraStorageIds?: string[];
  } = {},
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cct-delete-live-'));

  t.after(() => removeTemp(root));

  const ctx: TransferContext = {
    executable: executable!,
    initFile: await ensureInitFile(root),
  };

  const globalDbPath = path.join(root, 'global.vscdb');
  const storageIds = ['migrated', ...(spec.extraStorageIds || [])];
  const entries: WorkspaceEntry[] = [];

  for (const storageId of storageIds) {
    const directory = path.join(root, 'workspaceStorage', storageId);

    await fs.mkdir(directory, { recursive: true });
    const workspaceDbPath = path.join(directory, 'state.vscdb');

    entries.push({
      storageRoot: root,
      storageId,
      key: storageId,
      mtime: 0,
      globalDbPath,
      workspaceDbPath,
      identity: {
        kind: 'folder',
        uri: { scheme: 'file', authority: '', path: `/${storageId}` },
      },
    });

    const includeList =
      storageId === 'migrated' && spec.includeComposerData !== false;

    const composerData =
      spec.composerData === undefined
        ? {
            hasMigratedComposerData: true,
            hasMigratedMultipleComposers: true,
            selectedComposerIds: [A, B],
            lastFocusedComposerIds: [A],
          }
        : spec.composerData;

    const items = [`('unrelated','KEEP')`];

    if (includeList)
      items.push(
        `('composer.composerData',${sqlText(JSON.stringify(composerData))})`,
      );

    const localTable =
      spec.localHeaderTable === false
        ? ''
        : `CREATE TABLE composerHeaders(composerId TEXT PRIMARY KEY, workspaceId TEXT, value BLOB);
${(storageId === 'migrated' ? spec.localHeaderIds || [] : [])
  .map(
    (id) =>
      `INSERT INTO composerHeaders(composerId, workspaceId, value) VALUES (${sqlText(id)}, ${sqlText(storageId)}, ${sqlText(JSON.stringify({ composerId: id, workspaceIdentifier: { id: storageId } }))});`,
  )
  .join('\n')}`;

    await execSqlScript({
      ...ctx,
      database: workspaceDbPath,
      sql: `PRAGMA journal_mode=WAL;
CREATE TABLE ItemTable(key TEXT PRIMARY KEY, value BLOB);
${localTable}
INSERT INTO ItemTable VALUES ${items.join(',')};`,
    });
  }

  const headerColumn = spec.headerExtraColumn
    ? `, ${spec.headerExtraColumn}`
    : '';

  const headerRows = (spec.globalHeaders || []).map((row) => {
    const value = {
      composerId: row.composerId,
      name: row.composerId === A ? 'Migrated' : 'Other',
      workspaceIdentifier: { id: row.storageId },
    };

    return `INSERT INTO composerHeaders(composerId, workspaceId, value) VALUES (${sqlText(row.composerId)}, ${sqlText(row.storageId)}, ${sqlText(JSON.stringify(value))});`;
  });

  const kvRows = (spec.keys || []).map((key) => `(${sqlText(key)},'{}')`);

  const blob = spec.globalBlob
    ? `INSERT INTO ItemTable VALUES ('composer.composerHeaders',${sqlText(JSON.stringify(spec.globalBlob))});`
    : '';

  await execSqlScript({
    ...ctx,
    database: globalDbPath,
    sql: `PRAGMA journal_mode=WAL;
CREATE TABLE ItemTable(key TEXT PRIMARY KEY, value BLOB);
CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY, value BLOB);
CREATE TABLE composerHeaders(composerId TEXT PRIMARY KEY, workspaceId TEXT, value BLOB${headerColumn});
${headerRows.join('\n')}
${blob}
${kvRows.length ? `INSERT INTO cursorDiskKV VALUES ${kvRows.join(',')};` : ''}`,
  });

  const read = (database: string, query: string) =>
    execSql({ ...ctx, database, sql: query });

  return { ctx, entries, globalDbPath, read };
}

test(
  'ordinary deletion worker removes exclusive history, preserves shared data, and is repeatable',
  { skip },
  async (t) => {
    const { ctx, entries, globalDbPath, read } = await setup(t);
    const targets = [{ workspace: entries[0], ids: [A, A, B] }];

    const result = await runTransfer<
      import('../src/deletion-types').DeleteResult
    >(
      {
        kind: 'delete-chats',
        executable: ctx.executable,
        initFile: ctx.initFile,
        workspaces: entries,
        targets,
      },
      {},
    );

    assert.equal(result.error, undefined);
    assert.equal(result.deleted.length, 1);
    assert.equal(result.skipped.length, 1);

    const remaining = await read(
      globalDbPath,
      'SELECT key FROM cursorDiskKV ORDER BY key;',
    );

    assert.ok(!remaining.includes(A));
    assert.ok(remaining.includes(B) && remaining.includes(C));
    assert.match(remaining, /agentKv/);

    const state = await read(
      entries[0].workspaceDbPath,
      'SELECT value FROM ItemTable;',
    );

    assert.ok(!state.includes(A) && state.includes(B));
    assert.match(state, /KEEP/);
    const repeat = await deleteSelectedChats(ctx, entries, targets);

    assert.equal(repeat.deleted.length, 0);
    assert.equal(repeat.skipped.length, 2);
  },
);

test(
  'a symlinked parent still deletes a regular database file',
  { skip },
  async (t) => {
    const { ctx, entries, globalDbPath, read, root } = await setup(t);
    const alias = path.join(path.dirname(root), `${path.basename(root)}-link`);

    await fs.symlink(root, alias);
    t.after(() => fs.rm(alias, { force: true }));

    const through = (file: string) =>
      path.join(alias, path.relative(root, file));

    const linked = entries.map((entry) => ({
      ...entry,
      globalDbPath: through(globalDbPath),
      workspaceDbPath: through(entry.workspaceDbPath),
    }));

    const result = await deleteSelectedChats(ctx, linked, [
      { workspace: linked[0], ids: [A] },
    ]);

    assert.equal(result.error, undefined);
    assert.deepEqual(result.deleted, [`${linked[0].workspaceDbPath}: ${A}`]);

    const remaining = await read(
      globalDbPath,
      'SELECT key FROM cursorDiskKV ORDER BY key;',
    );

    assert.ok(!remaining.includes(A));
    assert.ok(remaining.includes(B));
  },
);

test(
  'cancellation after deleting rows rolls back both databases',
  { skip },
  async (t) => {
    const { ctx, entries, dump } = await setup(t);
    const before = await dump();
    const abort = new AbortController();
    const exec = SqliteSession.prototype.exec;

    t.after(() => {
      SqliteSession.prototype.exec = exec;
    });

    SqliteSession.prototype.exec = async function (sql) {
      const result = await exec.call(this, sql);

      if (sql.startsWith('DELETE FROM main.cursorDiskKV')) abort.abort();

      return result;
    };

    const result = await deleteSelectedChats(
      { ...ctx, signal: abort.signal },
      entries,
      [{ workspace: entries[0], ids: [A] }],
    );

    assert.equal(result.cancelled, true);
    assert.equal(result.deleted.length, 0);
    assert.deepEqual(await dump(), before);
  },
);

for (const scenario of [
  'broken metadata',
  'trigger',
  'foreign key',
  'unknown schema',
])
  test(
    `deletion refuses ${scenario} before committing`,
    { skip },
    async (t) => {
      const { ctx, entries, globalDbPath, dump } = await setup(t);

      if (scenario === 'broken metadata')
        await execSqlScript({
          ...ctx,
          database: entries[1].workspaceDbPath,
          sql: "UPDATE ItemTable SET value='{broken' WHERE key='composer.composerData';",
        });
      if (scenario === 'trigger')
        await execSqlScript({
          ...ctx,
          database: globalDbPath,
          sql: 'CREATE TRIGGER destructive AFTER DELETE ON cursorDiskKV BEGIN DELETE FROM ItemTable; END;',
        });
      if (scenario === 'foreign key')
        await execSqlScript({
          ...ctx,
          database: globalDbPath,
          sql: 'CREATE TABLE unrelated(parent TEXT REFERENCES cursorDiskKV(key) ON DELETE CASCADE);',
        });
      if (scenario === 'unknown schema')
        await execSqlScript({
          ...ctx,
          database: entries[0].workspaceDbPath,
          sql: 'CREATE TABLE composerHeaders(unknown TEXT);',
        });
      const before = await dump();

      const result = await deleteSelectedChats(ctx, entries, [
        { workspace: entries[0], ids: [A] },
      ]);

      assert.ok(result.error);
      assert.equal(result.deleted.length, 0);
      assert.deepEqual(await dump(), before);
    },
  );

test(
  'unresolved global ownership retains locally referenced history',
  { skip },
  async (t) => {
    const { ctx, entries, globalDbPath, dump } = await setup(t);

    await execSqlScript({
      ...ctx,
      database: globalDbPath,
      sql: `UPDATE ItemTable SET value=${sqlText(JSON.stringify({ allComposers: [{ composerId: A, workspaceIdentifier: { id: 'missing-storage' } }] }))} WHERE key='composer.composerHeaders';`,
    });

    const before = await dump();

    const result = await deleteSelectedChats(ctx, entries, [
      { workspace: entries[0], ids: [A] },
    ]);

    assert.equal(result.deleted.length, 0);
    assert.equal(result.skipped.length, 1);
    assert.deepEqual(await dump(), before);
  },
);

test(
  'a changed selected index aborts before mutation and preserves the concurrent change',
  { skip },
  async (t) => {
    const { ctx, entries, globalDbPath, read } = await setup(t);
    const exec = SqliteSession.prototype.exec;

    t.after(() => {
      SqliteSession.prototype.exec = exec;
    });

    let changed = false;

    SqliteSession.prototype.exec = async function (sql) {
      if (sql === 'BEGIN IMMEDIATE;' && !changed) {
        changed = true;

        await execSqlScript({
          ...ctx,
          database: globalDbPath,
          sql: `UPDATE ItemTable SET value=json_set(value,'$.allComposers[0].name','Changed concurrently') WHERE key='composer.composerHeaders';`,
        });
      }

      return exec.call(this, sql);
    };

    const result = await deleteSelectedChats(ctx, entries, [
      { workspace: entries[0], ids: [A] },
    ]);

    assert.match(result.error!, /indices changed/);
    assert.equal(result.deleted.length, 0);

    assert.match(
      await read(
        globalDbPath,
        "SELECT value FROM ItemTable WHERE key='composer.composerHeaders';",
      ),
      /Changed concurrently/,
    );

    assert.equal(
      (
        await read(
          globalDbPath,
          `SELECT count(*) FROM cursorDiskKV WHERE key=${sqlText(`composerData:${A}`)};`,
        )
      ).trim(),
      '1',
    );
  },
);

test(
  'a busy writer respects the configured wait and leaves all records intact',
  { skip },
  async (t) => {
    const { ctx, entries, globalDbPath, dump } = await setup(t);
    const before = await dump();
    const writer = await SqliteSession.open({ ...ctx, database: globalDbPath });

    try {
      await writer.exec('BEGIN IMMEDIATE;');

      const result = await deleteSelectedChats(
        { ...ctx, busyTimeoutMs: 0 },
        entries,
        [{ workspace: entries[0], ids: [A] }],
      );

      assert.ok(result.error);
      assert.equal(result.deleted.length, 0);
    } finally {
      await writer.close();
    }

    assert.deepEqual(await dump(), before);
  },
);

test(
  'cancellation between workspaces reports prior commits and leaves later chats intact',
  { skip },
  async (t) => {
    const { ctx, entries, globalDbPath, read } = await setup(t);
    const abort = new AbortController();

    const result = await deleteSelectedChats(
      { ...ctx, signal: abort.signal, onPhase: () => abort.abort() },
      entries,
      [
        { workspace: entries[0], ids: [A] },
        { workspace: entries[1], ids: [C] },
      ],
    );

    assert.equal(result.cancelled, true);
    assert.equal(result.deleted.length, 1);

    assert.equal(
      (
        await read(
          globalDbPath,
          `SELECT count(*) FROM cursorDiskKV WHERE key=${sqlText(`composerData:${C}`)};`,
        )
      ).trim(),
      '1',
    );
  },
);

test(
  'multi-workspace deletion rechecks each selection without invalidating later unrelated targets',
  { skip },
  async (t) => {
    const { ctx, entries, globalDbPath, read } = await setup(t);

    const result = await deleteSelectedChats(ctx, entries, [
      { workspace: entries[0], ids: [A] },
      { workspace: entries[1], ids: [C] },
    ]);

    assert.equal(result.error, undefined);
    assert.equal(result.deleted.length, 2);

    assert.ok(
      (await read(globalDbPath, 'SELECT key FROM cursorDiskKV;')).includes(B),
    );
  },
);

test(
  'large selections use bounded SQL requests and preserve unrelated records',
  { skip },
  async (t) => {
    const { ctx, entries, globalDbPath, read } = await setup(t);

    const ids = Array.from(
      { length: 130 },
      (_, i) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, '0')}`,
    );

    await execSqlScript({
      ...ctx,
      database: globalDbPath,
      sql: `BEGIN; ${ids.map((id) => `INSERT INTO cursorDiskKV VALUES (${sqlText(`composerData:${id}`)},'{}'),(${sqlText(`bubbleId:${id}:message`)},'{}');`).join('\n')} COMMIT;`,
    });

    await execSqlScript({
      ...ctx,
      database: entries[0].workspaceDbPath,
      sql: `UPDATE ItemTable SET value=${sqlText(JSON.stringify({ allComposers: [...ids, A, B].map((composerId) => ({ composerId })) }))} WHERE key='composer.composerData';`,
    });

    const exec = SqliteSession.prototype.exec;
    let insertRequests = 0;
    let deleteRequests = 0;

    t.after(() => {
      SqliteSession.prototype.exec = exec;
    });

    SqliteSession.prototype.exec = function (sql) {
      if (sql.startsWith('INSERT INTO selected')) insertRequests++;
      if (sql.startsWith('DELETE FROM main.cursorDiskKV')) deleteRequests++;

      return exec.call(this, sql);
    };

    const result = await deleteSelectedChats(ctx, entries, [
      { workspace: entries[0], ids },
    ]);

    assert.equal(result.error, undefined);
    assert.equal(result.deleted.length, 130);
    assert.equal(insertRequests, 3);
    assert.equal(deleteRequests, 3);

    assert.equal(
      (
        await read(
          globalDbPath,
          "SELECT count(*) FROM cursorDiskKV WHERE key LIKE 'composerData:aaaaaaaa%';",
        )
      ).trim(),
      '0',
    );

    assert.ok(
      (await read(globalDbPath, 'SELECT key FROM cursorDiskKV;')).includes(A),
    );
  },
);

test(
  'lost COMMIT acknowledgement is reported as uncertain rather than as a clean rollback',
  { skip },
  async (t) => {
    const { ctx, entries, globalDbPath, read } = await setup(t);
    const exec = SqliteSession.prototype.exec;

    t.after(() => {
      SqliteSession.prototype.exec = exec;
    });

    SqliteSession.prototype.exec = async function (sql) {
      const output = await exec.call(this, sql);

      if (sql === 'COMMIT;') throw new Error('Commit acknowledgement lost');

      return output;
    };

    const result = await deleteSelectedChats(ctx, entries, [
      { workspace: entries[0], ids: [A] },
    ]);

    assert.equal(result.uncertain, true);
    assert.equal(result.deleted.length, 0);

    assert.equal(
      (
        await read(
          globalDbPath,
          `SELECT count(*) FROM cursorDiskKV WHERE key=${sqlText(`composerData:${A}`)};`,
        )
      ).trim(),
      '0',
    );
  },
);

test(
  'migrated workspace lists without allComposers still delete indexed history',
  { skip },
  async (t) => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'cct-delete-migrated-'),
    );

    t.after(() => removeTemp(root));

    const ctx: TransferContext = {
      executable: executable!,
      initFile: await ensureInitFile(root),
    };

    const globalDbPath = path.join(root, 'global.vscdb');
    const directory = path.join(root, 'workspaceStorage', 'migrated');

    await fs.mkdir(directory, { recursive: true });
    const workspaceDbPath = path.join(directory, 'state.vscdb');

    const entry: WorkspaceEntry = {
      storageRoot: root,
      storageId: 'migrated',
      key: 'migrated',
      mtime: 0,
      globalDbPath,
      workspaceDbPath,
      identity: {
        kind: 'folder',
        uri: { scheme: 'file', authority: '', path: '/migrated' },
      },
    };

    const header = {
      composerId: A,
      name: 'Migrated',
      workspaceIdentifier: { id: 'migrated' },
    };

    const workspaceList = {
      hasMigratedComposerData: true,
      hasMigratedMultipleComposers: true,
      selectedComposerIds: [A, B],
      lastFocusedComposerIds: [A],
    };

    await execSqlScript({
      ...ctx,
      database: workspaceDbPath,
      sql: `PRAGMA journal_mode=WAL;
CREATE TABLE ItemTable(key TEXT PRIMARY KEY, value BLOB);
CREATE TABLE composerHeaders(composerId TEXT PRIMARY KEY, workspaceId TEXT, value BLOB);
INSERT INTO ItemTable VALUES ('composer.composerData',${sqlText(JSON.stringify(workspaceList))}),('unrelated','KEEP');`,
    });

    await execSqlScript({
      ...ctx,
      database: globalDbPath,
      sql: `PRAGMA journal_mode=WAL;
CREATE TABLE ItemTable(key TEXT PRIMARY KEY, value BLOB);
CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY, value BLOB);
CREATE TABLE composerHeaders(composerId TEXT PRIMARY KEY, workspaceId TEXT, value BLOB);
INSERT INTO composerHeaders(composerId, workspaceId, value) VALUES (${sqlText(A)}, 'migrated', ${sqlText(JSON.stringify(header))});
INSERT INTO cursorDiskKV VALUES (${sqlText(`composerData:${A}`)},'{}'),(${sqlText(`bubbleId:${A}:message`)},'{}'),(${sqlText(`composerData:${B}`)},'{}');`,
    });

    const result = await deleteSelectedChats(
      ctx,
      [entry],
      [{ workspace: entry, ids: [A] }],
    );

    assert.equal(result.error, undefined);
    assert.deepEqual(result.deleted, [`${workspaceDbPath}: ${A}`]);

    const stored = JSON.parse(
      (
        await execSql({
          ...ctx,
          database: workspaceDbPath,
          sql: "SELECT value FROM ItemTable WHERE key='composer.composerData';",
        })
      ).trim(),
    ) as {
      hasMigratedComposerData?: boolean;
      allComposers?: unknown;
      selectedComposerIds?: string[];
      lastFocusedComposerIds?: string[];
    };

    assert.equal(stored.hasMigratedComposerData, true);
    assert.equal(stored.allComposers, undefined);
    assert.deepEqual(stored.selectedComposerIds, [B]);
    assert.deepEqual(stored.lastFocusedComposerIds, []);

    assert.equal(
      (
        await execSql({
          ...ctx,
          database: globalDbPath,
          sql: `SELECT count(*) FROM composerHeaders WHERE composerId=${sqlText(A)};`,
        })
      ).trim(),
      '0',
    );

    assert.equal(
      (
        await execSql({
          ...ctx,
          database: globalDbPath,
          sql: `SELECT count(*) FROM cursorDiskKV WHERE key=${sqlText(`composerData:${A}`)};`,
        })
      ).trim(),
      '0',
    );

    assert.equal(
      (
        await execSql({
          ...ctx,
          database: globalDbPath,
          sql: `SELECT count(*) FROM cursorDiskKV WHERE key=${sqlText(`composerData:${B}`)};`,
        })
      ).trim(),
      '1',
    );

    const kept = await execSql({
      ...ctx,
      database: workspaceDbPath,
      sql: "SELECT value FROM ItemTable WHERE key='unrelated';",
    });

    assert.match(kept, /KEEP/);
  },
);

const headerKey = {
  main: 'composer.composerHeaders',
  workspace: 'composer.composerData',
} as const;

test(
  'header writer rejects malformed lists and selected ids without rewriting them',
  { skip },
  async (t) => {
    const { session } = await writerFixture(t);

    const cases: Array<[string, RegExp]> = [
      ['null', /Unsupported header list/],
      ['[]', /Unsupported header list/],
      ['"text"', /Unsupported header list/],
      ['{"allComposers":null}', /Unsupported header list/],
      ['{"allComposers":{"composerId":"x"}}', /Unsupported header list/],
      ['{"allComposers":[null]}', /Unsupported header list/],
      ['{"allComposers":["x"]}', /Unsupported header list/],
      ['{"allComposers":[{"composerId":1}]}', /Unsupported header list/],
      ['{"allComposers":[{"name":"missing id"}]}', /Unsupported header list/],
      [
        '{"allComposers":[],"selectedComposerIds":[1]}',
        /Unsupported selected chat list/,
      ],
      [
        '{"allComposers":[],"selectedComposerIds":"x"}',
        /Unsupported selected chat list/,
      ],
      [
        '{"allComposers":[],"lastFocusedComposerIds":[null]}',
        /Unsupported selected chat list/,
      ],
      [
        '{"allComposers":[],"lastFocusedComposerIds":{"id":"x"}}',
        /Unsupported selected chat list/,
      ],
      ['{"selectedComposerIds":[1]}', /Unsupported selected chat list/],
      ['{"lastFocusedComposerIds":null}', /Unsupported selected chat list/],
    ];

    for (const schema of ['main', 'workspace'] as const) {
      const key = headerKey[schema];

      await session.exec(
        `INSERT INTO ${schema}.ItemTable(key, value) VALUES (${sqlText(key)}, '{}');`,
      );

      for (const [raw, message] of cases) {
        await session.exec(
          `UPDATE ${schema}.ItemTable SET value=${sqlText(raw)} WHERE key=${sqlText(key)};`,
        );

        await assert.rejects(
          () =>
            deleteHeaderReferences(
              session,
              schema,
              writerLayout(false),
              new Set([A]),
            ),
          message,
          `${schema} ${raw}`,
        );

        assert.equal(
          await storedText(session, schema, key),
          raw,
          `${schema} ${raw}`,
        );
      }
    }
  },
);

test(
  'header writer keeps sibling fields and drops only selected ids',
  { skip },
  async (t) => {
    const { session } = await writerFixture(t);

    const listed = {
      hasMigratedComposerData: true,
      custom: { keep: true },
      allComposers: [
        { composerId: A, name: 'Gone', pinned: true },
        { composerId: B, name: 'Stay', pinned: false },
      ],
      selectedComposerIds: [A, B],
      lastFocusedComposerIds: [B, A],
    };

    const migrated = {
      hasMigratedMultipleComposers: true,
      selectedComposerIds: [A, B],
      lastFocusedComposerIds: [A],
    };

    for (const schema of ['main', 'workspace'] as const) {
      const key = headerKey[schema];

      await session.exec(
        `DELETE FROM selected;
INSERT INTO ${schema}.ItemTable(key, value) VALUES (${sqlText(key)}, ${sqlText(JSON.stringify(listed))});
INSERT INTO ${schema}.composerHeaders(composerId, value) VALUES (${sqlText(A)}, '{}'), (${sqlText(B)}, '{}'), ('abc', '{}'), ('abcd', '{}');
INSERT INTO selected VALUES (${sqlText(A)}), ('abc');`,
      );

      await deleteHeaderReferences(
        session,
        schema,
        writerLayout(true),
        new Set([A, 'abc']),
      );

      assert.deepEqual(JSON.parse(await storedText(session, schema, key)), {
        hasMigratedComposerData: true,
        custom: { keep: true },
        allComposers: [{ composerId: B, name: 'Stay', pinned: false }],
        selectedComposerIds: [B],
        lastFocusedComposerIds: [B],
      });

      assert.deepEqual(
        (
          await session.exec(
            `SELECT composerId FROM ${schema}.composerHeaders ORDER BY composerId;`,
          )
        )
          .trim()
          .split(/\s+/)
          .filter(Boolean),
        [B, 'abcd'],
      );

      await session.exec(
        `DELETE FROM selected;
UPDATE ${schema}.ItemTable SET value=${sqlText(JSON.stringify(migrated))} WHERE key=${sqlText(key)};
INSERT INTO selected VALUES (${sqlText(A)});`,
      );

      await deleteHeaderReferences(
        session,
        schema,
        writerLayout(false),
        new Set([A]),
      );

      assert.deepEqual(JSON.parse(await storedText(session, schema, key)), {
        hasMigratedMultipleComposers: true,
        selectedComposerIds: [B],
        lastFocusedComposerIds: [],
      });

      assert.equal(
        (
          await session.exec(`SELECT count(*) FROM ${schema}.composerHeaders;`)
        ).trim(),
        '2',
      );
    }
  },
);

test(
  'a missing header item still deletes selected composerHeaders rows',
  { skip },
  async (t) => {
    const { session } = await writerFixture(t);

    await session.exec(
      `INSERT INTO composerHeaders(composerId, value) VALUES (${sqlText(A)}, '{}'), (${sqlText(B)}, '{}'), ('abc', '{}'), ('abcd', '{}');
INSERT INTO selected VALUES (${sqlText(A)}), ('abc');`,
    );

    await deleteHeaderReferences(
      session,
      'main',
      writerLayout(true),
      new Set([A, 'abc']),
    );

    assert.deepEqual(
      (
        await session.exec(
          'SELECT composerId FROM composerHeaders ORDER BY composerId;',
        )
      )
        .trim()
        .split(/\s+/)
        .filter(Boolean),
      [B, 'abcd'],
    );

    assert.equal(
      (
        await session.exec(
          "SELECT count(*) FROM ItemTable WHERE key='composer.composerHeaders';",
        )
      ).trim(),
      '0',
    );
  },
);

test(
  'header metadata above the supported record limit is left untouched',
  { skip },
  async (t) => {
    const { session } = await writerFixture(t);
    const bytes = MAX_SQLITE_VALUE_BYTES + 1;

    await session.exec(
      `INSERT INTO ItemTable(key, value) VALUES ('composer.composerHeaders', randomblob(${bytes}));
INSERT INTO workspace.ItemTable(key, value) VALUES ('composer.composerData', randomblob(${bytes}));`,
    );

    for (const schema of ['main', 'workspace'] as const) {
      await assert.rejects(
        () =>
          deleteHeaderReferences(
            session,
            schema,
            writerLayout(true),
            new Set([A]),
          ),
        /Header metadata exceeds the supported record limit/,
      );
    }

    assert.equal(
      (
        await session.exec(
          "SELECT length(value) FROM ItemTable WHERE key='composer.composerHeaders';",
        )
      ).trim(),
      String(bytes),
    );

    assert.equal(
      (
        await session.exec(
          "SELECT length(value) FROM workspace.ItemTable WHERE key='composer.composerData';",
        )
      ).trim(),
      String(bytes),
    );
  },
);

test(
  'message deletion removes only the exact composer row and its bubble range',
  { skip },
  async (t) => {
    const { session } = await writerFixture(t);

    const gone = [
      `composerData:${A}`,
      `bubbleId:${A}:`,
      `bubbleId:${A}:message`,
    ];

    const kept = [
      `bubbleId:${A}`,
      `bubbleId:${A};next`,
      `composerData:${A}:tail`,
      `agentKv:${A}:blob`,
      `composerData:${B}`,
      `bubbleId:${B}:message`,
    ];

    await session.exec(
      [...gone, ...kept]
        .map(
          (key) => `INSERT INTO cursorDiskKV VALUES (${sqlText(key)}, '{}');`,
        )
        .join('\n'),
    );

    await deleteMessageRows(session, [A]);

    const left = (
      await session.exec('SELECT key FROM cursorDiskKV ORDER BY key;')
    )
      .trim()
      .split(/\s+/)
      .filter(Boolean);

    assert.deepEqual(left, [...kept].sort());

    const abort = new AbortController();

    abort.abort();

    await session.exec(
      `INSERT INTO cursorDiskKV VALUES (${sqlText(`composerData:${C}`)}, '{}');`,
    );

    await assert.rejects(() => deleteMessageRows(session, [C], abort.signal), {
      name: 'AbortError',
    });

    assert.match(
      await session.exec('SELECT key FROM cursorDiskKV;'),
      new RegExp(`composerData:${C}`),
    );
  },
);

test(
  'message verification failure rolls the delete back',
  { skip },
  async (t) => {
    const { ctx, entries, dump } = await setup(t);
    const before = await dump();
    const exec = SqliteSession.prototype.exec;

    t.after(() => {
      SqliteSession.prototype.exec = exec;
    });

    SqliteSession.prototype.exec = async function (sql) {
      if (sql.includes('SELECT EXISTS')) return '1';

      return exec.call(this, sql);
    };

    const result = await deleteSelectedChats(ctx, entries, [
      { workspace: entries[0], ids: [A] },
    ]);

    assert.match(result.error || '', /Deletion verification failed/);
    assert.equal(result.deleted.length, 0);
    assert.equal(result.uncertain, undefined);
    assert.deepEqual(await dump(), before);
  },
);

test(
  'cancelling a later message batch rolls back the earlier batch and its headers',
  { skip },
  async (t) => {
    const { ctx, entries, dump } = await setup(t);

    const ids = Array.from(
      { length: 65 },
      (_, index) =>
        `bbbbbbbb-bbbb-4bbb-8bbb-${String(index).padStart(12, '0')}`,
    );

    await execSqlScript({
      ...ctx,
      database: entries[0].globalDbPath,
      sql: `BEGIN; ${ids.map((id) => `INSERT INTO cursorDiskKV VALUES (${sqlText(`composerData:${id}`)},'{}'),(${sqlText(`bubbleId:${id}:message`)},'{}');`).join('\n')} COMMIT;`,
    });

    await execSqlScript({
      ...ctx,
      database: entries[0].workspaceDbPath,
      sql: `UPDATE ItemTable SET value=${sqlText(JSON.stringify({ allComposers: [...ids, A, B].map((composerId) => ({ composerId })), selectedComposerIds: [A, B], lastFocusedComposerIds: [A] }))} WHERE key='composer.composerData';`,
    });

    const before = await dump();
    const abort = new AbortController();
    const exec = SqliteSession.prototype.exec;

    t.after(() => {
      SqliteSession.prototype.exec = exec;
    });

    SqliteSession.prototype.exec = async function (sql) {
      const output = await exec.call(this, sql);

      if (sql.startsWith('DELETE FROM main.cursorDiskKV')) abort.abort();

      return output;
    };

    const result = await deleteSelectedChats(
      { ...ctx, signal: abort.signal },
      entries,
      [{ workspace: entries[0], ids }],
    );

    assert.equal(result.cancelled, true);
    assert.equal(result.deleted.length, 0);
    assert.deepEqual(await dump(), before);
  },
);

test(
  'exclusive deletion keeps sibling header fields in both legacy lists',
  { skip },
  async (t) => {
    const { ctx, entries, globalDbPath, read } = await setup(t);

    const workspaceList = {
      hasMigratedComposerData: false,
      custom: { keep: true },
      allComposers: [
        { composerId: A, name: 'Gone', pinned: true },
        { composerId: B, name: 'Stay', pinned: false },
      ],
      selectedComposerIds: [A, B],
      lastFocusedComposerIds: [A, B],
    };

    const globalList = {
      custom: { keep: true },
      allComposers: [
        {
          composerId: A,
          name: 'Gone',
          pinned: true,
          workspaceIdentifier: { id: 'one' },
        },
        {
          composerId: C,
          name: 'Other',
          pinned: false,
          workspaceIdentifier: { id: 'two' },
        },
      ],
      selectedComposerIds: [A, C],
    };

    await execSqlScript({
      ...ctx,
      database: entries[0].workspaceDbPath,
      sql: `UPDATE ItemTable SET value=${sqlText(JSON.stringify(workspaceList))} WHERE key='composer.composerData';`,
    });

    await execSqlScript({
      ...ctx,
      database: globalDbPath,
      sql: `UPDATE ItemTable SET value=${sqlText(JSON.stringify(globalList))} WHERE key='composer.composerHeaders';
INSERT INTO cursorDiskKV VALUES (${sqlText(`bubbleId:${A}`)}, 'KEEP'), (${sqlText(`bubbleId:${A};next`)}, 'KEEP'), (${sqlText(`composerData:${A}:tail`)}, 'KEEP'), (${sqlText(`agentKv:${A}:blob`)}, 'KEEP');`,
    });

    const result = await deleteSelectedChats(ctx, entries, [
      { workspace: entries[0], ids: [A] },
    ]);

    assert.equal(result.error, undefined);
    assert.deepEqual(result.deleted, [`${entries[0].workspaceDbPath}: ${A}`]);

    assert.deepEqual(
      JSON.parse(
        (
          await read(
            entries[0].workspaceDbPath,
            "SELECT value FROM ItemTable WHERE key='composer.composerData';",
          )
        ).trim(),
      ),
      {
        hasMigratedComposerData: false,
        custom: { keep: true },
        allComposers: [{ composerId: B, name: 'Stay', pinned: false }],
        selectedComposerIds: [B],
        lastFocusedComposerIds: [B],
      },
    );

    assert.deepEqual(
      JSON.parse(
        (
          await read(
            globalDbPath,
            "SELECT value FROM ItemTable WHERE key='composer.composerHeaders';",
          )
        ).trim(),
      ),
      {
        custom: { keep: true },
        allComposers: [
          {
            composerId: C,
            name: 'Other',
            pinned: false,
            workspaceIdentifier: { id: 'two' },
          },
        ],
        selectedComposerIds: [C],
      },
    );

    const keys = new Set(
      (await read(globalDbPath, 'SELECT key FROM cursorDiskKV ORDER BY key;'))
        .trim()
        .split(/\s+/)
        .filter(Boolean),
    );

    assert.equal(keys.has(`composerData:${A}`), false);
    assert.equal(keys.has(`bubbleId:${A}:message`), false);
    assert.equal(keys.has(`bubbleId:${A}`), true);
    assert.equal(keys.has(`bubbleId:${A};next`), true);
    assert.equal(keys.has(`composerData:${A}:tail`), true);
    assert.equal(keys.has(`agentKv:${A}:blob`), true);
    assert.equal(keys.has(`composerData:${B}`), true);
  },
);

test(
  'a migrated chat stays exclusive when another window shares the global table',
  { skip },
  async (t) => {
    const { ctx, entries, globalDbPath, read } = await liveWorkspace(t, {
      extraStorageIds: ['other'],
      localHeaderIds: [A, E],
      globalHeaders: [
        { composerId: A, storageId: 'migrated' },
        { composerId: E, storageId: 'migrated' },
        { composerId: D, storageId: 'other' },
      ],
      globalBlob: {
        custom: { keep: true },
        allComposers: [
          {
            composerId: A,
            name: 'Gone',
            pinned: true,
            workspaceIdentifier: { id: 'migrated' },
          },
          {
            composerId: E,
            name: 'Also',
            pinned: true,
            workspaceIdentifier: { id: 'migrated' },
          },
          {
            composerId: D,
            name: 'Other',
            pinned: false,
            workspaceIdentifier: { id: 'other' },
          },
        ],
        selectedComposerIds: [A, E, D],
      },
      keys: [
        `composerData:${A}`,
        `bubbleId:${A}:message`,
        `bubbleId:${A}`,
        `composerData:${E}`,
        `composerData:${D}`,
        `composerData:${B}`,
        `agentKv:${A}:blob`,
      ],
    });

    const result = await deleteSelectedChats(ctx, entries, [
      { workspace: entries[0], ids: [A, E] },
    ]);

    assert.equal(result.error, undefined);

    assert.deepEqual(
      result.deleted,
      [A, E].map((id) => `${entries[0].workspaceDbPath}: ${id}`),
    );

    const workspaceList = JSON.parse(
      (
        await read(
          entries[0].workspaceDbPath,
          "SELECT value FROM ItemTable WHERE key='composer.composerData';",
        )
      ).trim(),
    ) as {
      hasMigratedComposerData?: boolean;
      allComposers?: unknown;
      selectedComposerIds?: string[];
      lastFocusedComposerIds?: string[];
      custom?: unknown;
    };

    assert.equal(workspaceList.hasMigratedComposerData, true);
    assert.equal(workspaceList.allComposers, undefined);
    assert.deepEqual(workspaceList.selectedComposerIds, [B]);
    assert.deepEqual(workspaceList.lastFocusedComposerIds, []);

    assert.deepEqual(
      JSON.parse(
        (
          await read(
            globalDbPath,
            "SELECT value FROM ItemTable WHERE key='composer.composerHeaders';",
          )
        ).trim(),
      ),
      {
        custom: { keep: true },
        allComposers: [
          {
            composerId: D,
            name: 'Other',
            pinned: false,
            workspaceIdentifier: { id: 'other' },
          },
        ],
        selectedComposerIds: [D],
      },
    );

    assert.equal(
      (
        await read(
          globalDbPath,
          `SELECT group_concat(composerId, ',') FROM composerHeaders ORDER BY composerId;`,
        )
      ).trim(),
      D,
    );

    assert.equal(
      (
        await read(
          entries[0].workspaceDbPath,
          'SELECT count(*) FROM composerHeaders;',
        )
      ).trim(),
      '0',
    );

    const keys = new Set(
      (await read(globalDbPath, 'SELECT key FROM cursorDiskKV ORDER BY key;'))
        .trim()
        .split(/\s+/)
        .filter(Boolean),
    );

    assert.equal(keys.has(`composerData:${A}`), false);
    assert.equal(keys.has(`composerData:${E}`), false);
    assert.equal(keys.has(`bubbleId:${A}:message`), false);
    assert.equal(keys.has(`bubbleId:${A}`), true);
    assert.equal(keys.has(`composerData:${B}`), true);
    assert.equal(keys.has(`composerData:${D}`), true);
    assert.equal(keys.has(`agentKv:${A}:blob`), true);

    assert.match(
      await read(
        entries[1].workspaceDbPath,
        "SELECT value FROM ItemTable WHERE key='unrelated';",
      ),
      /KEEP/,
    );
  },
);

test(
  'a chat indexed only by the global table is deleted when the workspace list key is absent',
  { skip },
  async (t) => {
    const { ctx, entries, globalDbPath, read } = await liveWorkspace(t, {
      includeComposerData: false,
      localHeaderTable: false,
      globalHeaders: [
        { composerId: A, storageId: 'migrated' },
        { composerId: D, storageId: 'migrated' },
      ],
      keys: [`composerData:${A}`, `bubbleId:${A}:message`, `composerData:${D}`],
    });

    const result = await deleteSelectedChats(ctx, entries, [
      { workspace: entries[0], ids: [A] },
    ]);

    assert.equal(result.error, undefined);
    assert.deepEqual(result.deleted, [`${entries[0].workspaceDbPath}: ${A}`]);

    assert.equal(
      (
        await read(
          globalDbPath,
          `SELECT group_concat(composerId, ',') FROM composerHeaders ORDER BY composerId;`,
        )
      ).trim(),
      D,
    );

    assert.equal(
      (
        await read(
          globalDbPath,
          `SELECT count(*) FROM cursorDiskKV WHERE key=${sqlText(`composerData:${A}`)};`,
        )
      ).trim(),
      '0',
    );

    assert.equal(
      (
        await read(
          globalDbPath,
          `SELECT count(*) FROM cursorDiskKV WHERE key=${sqlText(`composerData:${D}`)};`,
        )
      ).trim(),
      '1',
    );

    assert.equal(
      (
        await read(
          entries[0].workspaceDbPath,
          "SELECT count(*) FROM ItemTable WHERE key='composer.composerData';",
        )
      ).trim(),
      '0',
    );
  },
);

test(
  'a nullable unknown composerHeaders column still allows deletion',
  { skip },
  async (t) => {
    const { ctx, entries, globalDbPath, read } = await liveWorkspace(t, {
      headerExtraColumn: 'subagentTypeName TEXT',
      globalHeaders: [{ composerId: A, storageId: 'migrated' }],
      keys: [`composerData:${A}`],
    });

    const result = await deleteSelectedChats(ctx, entries, [
      { workspace: entries[0], ids: [A] },
    ]);

    assert.equal(result.error, undefined);
    assert.equal(result.deleted.length, 1);

    assert.equal(
      (
        await read(globalDbPath, 'SELECT count(*) FROM composerHeaders;')
      ).trim(),
      '0',
    );
  },
);

test(
  'a global header bound to an unknown window is retained',
  { skip },
  async (t) => {
    const { ctx, entries, globalDbPath, read, dump } = await setup(t);

    await execSqlScript({
      ...ctx,
      database: globalDbPath,
      sql: `CREATE TABLE composerHeaders(composerId TEXT PRIMARY KEY, workspaceId TEXT, value BLOB);
INSERT INTO composerHeaders(composerId, workspaceId, value) VALUES (${sqlText(D)}, 'missing-storage', ${sqlText(JSON.stringify({ composerId: D, workspaceIdentifier: { id: 'missing-storage' } }))});
INSERT INTO cursorDiskKV VALUES (${sqlText(`composerData:${D}`)}, '{}');`,
    });

    const before = await dump();

    const result = await deleteSelectedChats(ctx, entries, [
      { workspace: entries[0], ids: [D] },
    ]);

    assert.equal(result.deleted.length, 0);
    assert.match(result.skipped[0] || '', /shared, absent, or unverified/);
    assert.deepEqual(await dump(), before);

    assert.equal(
      (
        await read(
          globalDbPath,
          `SELECT count(*) FROM composerHeaders WHERE composerId=${sqlText(D)};`,
        )
      ).trim(),
      '1',
    );
  },
);

test(
  'a header with no workspace binding is deleted when the local list owns it',
  { skip },
  async (t) => {
    const { ctx, entries, globalDbPath, read } = await setup(t);

    await execSqlScript({
      ...ctx,
      database: globalDbPath,
      sql: `UPDATE ItemTable SET value=${sqlText(
        JSON.stringify({
          allComposers: [
            { composerId: A, name: 'Unbound' },
            {
              composerId: C,
              name: 'Other',
              workspaceIdentifier: { id: 'two' },
            },
          ],
        }),
      )} WHERE key='composer.composerHeaders';`,
    });

    const result = await deleteSelectedChats(ctx, entries, [
      { workspace: entries[0], ids: [A] },
    ]);

    assert.equal(result.error, undefined);
    assert.equal(result.deleted.length, 1);

    const globalList = JSON.parse(
      (
        await read(
          globalDbPath,
          "SELECT value FROM ItemTable WHERE key='composer.composerHeaders';",
        )
      ).trim(),
    ) as { allComposers: Array<{ composerId: string }> };

    assert.deepEqual(
      globalList.allComposers.map((row) => row.composerId),
      [C],
    );

    assert.equal(
      (
        await read(
          globalDbPath,
          `SELECT count(*) FROM cursorDiskKV WHERE key=${sqlText(`composerData:${A}`)};`,
        )
      ).trim(),
      '0',
    );
  },
);

test(
  'an empty local composer list still deletes a chat indexed globally',
  { skip },
  async (t) => {
    const { ctx, entries, globalDbPath, read } = await setup(t);

    await execSqlScript({
      ...ctx,
      database: entries[0].workspaceDbPath,
      sql: `UPDATE ItemTable SET value=${sqlText(JSON.stringify({ allComposers: [], selectedComposerIds: [A, B], lastFocusedComposerIds: [A, B], hasMigratedComposerData: true }))} WHERE key='composer.composerData';`,
    });

    const result = await deleteSelectedChats(ctx, entries, [
      { workspace: entries[0], ids: [A] },
    ]);

    assert.equal(result.error, undefined);
    assert.equal(result.deleted.length, 1);

    const stored = JSON.parse(
      (
        await read(
          entries[0].workspaceDbPath,
          "SELECT value FROM ItemTable WHERE key='composer.composerData';",
        )
      ).trim(),
    ) as {
      allComposers: unknown[];
      selectedComposerIds: string[];
      lastFocusedComposerIds: string[];
      hasMigratedComposerData: boolean;
    };

    assert.deepEqual(stored.allComposers, []);
    assert.deepEqual(stored.selectedComposerIds, [B]);
    assert.deepEqual(stored.lastFocusedComposerIds, [B]);
    assert.equal(stored.hasMigratedComposerData, true);

    assert.equal(
      (
        await read(
          globalDbPath,
          `SELECT count(*) FROM cursorDiskKV WHERE key=${sqlText(`composerData:${A}`)};`,
        )
      ).trim(),
      '0',
    );
  },
);

for (const [label, value, message] of [
  ['a null composer list', { allComposers: null }, /Invalid chat header list/],
  [
    'a composer row without a string id',
    { allComposers: [{ composerId: 1 }], selectedComposerIds: [A] },
    /Invalid chat header list/,
  ],
  ['a header value that is an array', [], /Invalid chat header metadata/],
] as const)
  test(`${label} rolls deletion back`, { skip }, async (t) => {
    const { ctx, entries, globalDbPath, read } = await setup(t);

    const before = await read(
      globalDbPath,
      'SELECT key,value FROM cursorDiskKV ORDER BY key;',
    );

    await execSqlScript({
      ...ctx,
      database: entries[0].workspaceDbPath,
      sql: `UPDATE ItemTable SET value=${sqlText(JSON.stringify(value))} WHERE key='composer.composerData';`,
    });

    const result = await deleteSelectedChats(ctx, entries, [
      { workspace: entries[0], ids: [A] },
    ]);

    assert.match(result.error || '', message);
    assert.equal(result.deleted.length, 0);

    assert.equal(
      await read(
        globalDbPath,
        'SELECT key,value FROM cursorDiskKV ORDER BY key;',
      ),
      before,
    );
  });

test(
  'a bad selected-id list rolls back the global header update in the same transaction',
  { skip },
  async (t) => {
    const { ctx, entries, globalDbPath, read } = await setup(t);

    const globalBefore = await read(
      globalDbPath,
      "SELECT value FROM ItemTable WHERE key='composer.composerHeaders';",
    );

    await execSqlScript({
      ...ctx,
      database: entries[0].workspaceDbPath,
      sql: `UPDATE ItemTable SET value=${sqlText(JSON.stringify({ allComposers: [{ composerId: A }, { composerId: B }], selectedComposerIds: [1], lastFocusedComposerIds: [A, B] }))} WHERE key='composer.composerData';`,
    });

    const result = await deleteSelectedChats(ctx, entries, [
      { workspace: entries[0], ids: [A] },
    ]);

    assert.match(result.error || '', /Unsupported selected chat list/);
    assert.equal(result.deleted.length, 0);

    assert.equal(
      await read(
        globalDbPath,
        "SELECT value FROM ItemTable WHERE key='composer.composerHeaders';",
      ),
      globalBefore,
    );

    assert.equal(
      (
        await read(
          globalDbPath,
          `SELECT count(*) FROM cursorDiskKV WHERE key=${sqlText(`composerData:${A}`)};`,
        )
      ).trim(),
      '1',
    );
  },
);

test(
  'a bad focused-id list on the global header rolls deletion back',
  { skip },
  async (t) => {
    const { ctx, entries, globalDbPath, read } = await setup(t);

    await execSqlScript({
      ...ctx,
      database: globalDbPath,
      sql: `UPDATE ItemTable SET value=${sqlText(
        JSON.stringify({
          allComposers: [
            { composerId: A, workspaceIdentifier: { id: 'one' } },
            { composerId: C, workspaceIdentifier: { id: 'two' } },
          ],
          lastFocusedComposerIds: [1],
        }),
      )} WHERE key='composer.composerHeaders';`,
    });

    const result = await deleteSelectedChats(ctx, entries, [
      { workspace: entries[0], ids: [A] },
    ]);

    assert.match(result.error || '', /Unsupported selected chat list/);
    assert.equal(result.deleted.length, 0);

    assert.equal(
      (
        await read(
          globalDbPath,
          `SELECT count(*) FROM cursorDiskKV WHERE key=${sqlText(`composerData:${A}`)};`,
        )
      ).trim(),
      '1',
    );

    assert.match(
      await read(
        entries[0].workspaceDbPath,
        "SELECT value FROM ItemTable WHERE key='composer.composerData';",
      ),
      new RegExp(A),
    );
  },
);

test(
  'a changed workspace index aborts before mutation',
  { skip },
  async (t) => {
    const { ctx, entries, globalDbPath, read } = await setup(t);
    const exec = SqliteSession.prototype.exec;

    t.after(() => {
      SqliteSession.prototype.exec = exec;
    });

    SqliteSession.prototype.exec = async function (sql) {
      if (sql === 'BEGIN IMMEDIATE;') {
        SqliteSession.prototype.exec = exec;

        await execSqlScript({
          ...ctx,
          database: entries[0].workspaceDbPath,
          sql: `UPDATE ItemTable SET value=json_set(value,'$.allComposers[0].name','Changed locally') WHERE key='composer.composerData';`,
        });
      }

      return exec.call(this, sql);
    };

    const result = await deleteSelectedChats(ctx, entries, [
      { workspace: entries[0], ids: [A] },
    ]);

    assert.match(result.error || '', /workspace indices changed/);
    assert.equal(result.deleted.length, 0);

    assert.equal(
      (
        await read(
          globalDbPath,
          `SELECT count(*) FROM cursorDiskKV WHERE key=${sqlText(`composerData:${A}`)};`,
        )
      ).trim(),
      '1',
    );
  },
);

test(
  'a changed composerHeaders row aborts before mutation',
  { skip },
  async (t) => {
    const { ctx, entries, globalDbPath, read } = await liveWorkspace(t, {
      globalHeaders: [{ composerId: A, storageId: 'migrated' }],
      keys: [`composerData:${A}`],
    });

    const exec = SqliteSession.prototype.exec;

    t.after(() => {
      SqliteSession.prototype.exec = exec;
    });

    SqliteSession.prototype.exec = async function (sql) {
      if (sql === 'BEGIN IMMEDIATE;') {
        SqliteSession.prototype.exec = exec;

        await execSqlScript({
          ...ctx,
          database: globalDbPath,
          sql: `UPDATE composerHeaders SET value=json_set(value,'$.name','Changed in table') WHERE composerId=${sqlText(A)};`,
        });
      }

      return exec.call(this, sql);
    };

    const result = await deleteSelectedChats(ctx, entries, [
      { workspace: entries[0], ids: [A] },
    ]);

    assert.match(result.error || '', /indices changed/);
    assert.equal(result.deleted.length, 0);

    assert.match(
      await read(
        globalDbPath,
        `SELECT value FROM composerHeaders WHERE composerId=${sqlText(A)};`,
      ),
      /Changed in table/,
    );

    assert.equal(
      (
        await read(
          globalDbPath,
          `SELECT count(*) FROM cursorDiskKV WHERE key=${sqlText(`composerData:${A}`)};`,
        )
      ).trim(),
      '1',
    );
  },
);

test(
  'a later workspace schema failure keeps the earlier committed deletion',
  { skip },
  async (t) => {
    const { ctx, entries, globalDbPath, read } = await setup(t);

    const exec = SqliteSession.prototype.exec;
    let changed = false;

    t.after(() => {
      SqliteSession.prototype.exec = exec;
    });

    SqliteSession.prototype.exec = async function (sql) {
      const output = await exec.call(this, sql);

      // The preflight was valid; the next workspace changes after the first commit.
      if (sql === 'COMMIT;' && !changed) {
        changed = true;

        await execSqlScript({
          ...ctx,
          database: entries[1].workspaceDbPath,
          sql: 'CREATE TABLE composerHeaders(unknown TEXT);',
        });
      }

      return output;
    };

    const result = await deleteSelectedChats(ctx, entries, [
      { workspace: entries[0], ids: [A] },
      { workspace: entries[1], ids: [C] },
    ]);

    assert.match(result.error || '', /Unsupported database schema/);
    assert.deepEqual(result.deleted, [`${entries[0].workspaceDbPath}: ${A}`]);

    assert.equal(
      (
        await read(
          globalDbPath,
          `SELECT count(*) FROM cursorDiskKV WHERE key=${sqlText(`composerData:${A}`)};`,
        )
      ).trim(),
      '0',
    );

    assert.equal(
      (
        await read(
          globalDbPath,
          `SELECT count(*) FROM cursorDiskKV WHERE key=${sqlText(`composerData:${C}`)};`,
        )
      ).trim(),
      '1',
    );

    assert.match(
      await read(
        entries[1].workspaceDbPath,
        "SELECT value FROM ItemTable WHERE key='composer.composerData';",
      ),
      new RegExp(C),
    );
  },
);

test(
  'an unknown NOT NULL composerHeaders column blocks deletion',
  { skip },
  async (t) => {
    const { ctx, entries, dump } = await setup(t);

    await execSqlScript({
      ...ctx,
      database: entries[0].globalDbPath,
      sql: 'CREATE TABLE composerHeaders(composerId TEXT, value BLOB, secret TEXT NOT NULL);',
    });

    const before = await dump();

    const result = await deleteSelectedChats(ctx, entries, [
      { workspace: entries[0], ids: [A] },
    ]);

    assert.match(result.error || '', /Unsupported database schema/);
    assert.equal(result.deleted.length, 0);
    assert.deepEqual(await dump(), before);
  },
);

test(
  'an unknown NOT NULL ItemTable column blocks deletion',
  { skip },
  async (t) => {
    const { ctx, entries, dump } = await setup(t);

    await execSqlScript({
      ...ctx,
      database: entries[0].workspaceDbPath,
      sql: `CREATE TABLE ItemTable_new(key TEXT NOT NULL, value BLOB, secret TEXT NOT NULL, PRIMARY KEY(key));
INSERT INTO ItemTable_new(key, value, secret) SELECT key, value, 'x' FROM ItemTable;
DROP TABLE ItemTable;
ALTER TABLE ItemTable_new RENAME TO ItemTable;`,
    });

    const before = await dump();

    const result = await deleteSelectedChats(ctx, entries, [
      { workspace: entries[0], ids: [A] },
    ]);

    assert.match(result.error || '', /Unsupported database schema/);
    assert.equal(result.deleted.length, 0);
    assert.deepEqual(await dump(), before);
  },
);

test(
  'a trigger on an unrelated table does not block deletion',
  { skip },
  async (t) => {
    const { ctx, entries, globalDbPath, read } = await setup(t);

    await execSqlScript({
      ...ctx,
      database: globalDbPath,
      sql: 'CREATE TABLE notes(body TEXT); CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN SELECT 1; END;',
    });

    const result = await deleteSelectedChats(ctx, entries, [
      { workspace: entries[0], ids: [A] },
    ]);

    assert.equal(result.error, undefined);
    assert.equal(result.deleted.length, 1);

    assert.equal(
      (
        await read(
          globalDbPath,
          `SELECT count(*) FROM cursorDiskKV WHERE key=${sqlText(`composerData:${A}`)};`,
        )
      ).trim(),
      '0',
    );

    assert.equal(
      (
        await read(
          globalDbPath,
          "SELECT count(*) FROM sqlite_schema WHERE name='notes';",
        )
      ).trim(),
      '1',
    );
  },
);

test(
  'shared, absent, empty, and duplicate selections do not invent deletions',
  { skip },
  async (t) => {
    const { ctx, entries, dump } = await setup(t);
    const before = await dump();

    const shared = await deleteSelectedChats(ctx, entries, [
      { workspace: entries[0], ids: [B] },
    ]);

    assert.equal(shared.deleted.length, 0);
    assert.match(shared.skipped[0] || '', /shared, absent, or unverified/);

    const absent = await deleteSelectedChats(ctx, entries, [
      { workspace: entries[0], ids: [E] },
    ]);

    assert.equal(absent.deleted.length, 0);
    assert.equal(absent.skipped.length, 1);

    const otherWindow = await deleteSelectedChats(ctx, entries, [
      { workspace: entries[1], ids: [A] },
    ]);

    assert.equal(otherWindow.deleted.length, 0);
    assert.equal(otherWindow.skipped.length, 1);

    const empty = await deleteSelectedChats(ctx, entries, [
      { workspace: entries[0], ids: [] },
    ]);

    assert.equal(empty.error, undefined);
    assert.equal(empty.deleted.length, 0);

    const abort = new AbortController();

    abort.abort();

    const cancelled = await deleteSelectedChats(
      { ...ctx, signal: abort.signal },
      entries,
      [{ workspace: entries[0], ids: [A] }],
    );

    assert.equal(cancelled.cancelled, true);
    assert.equal(cancelled.deleted.length, 0);
    assert.deepEqual(await dump(), before);

    const duplicated = await deleteSelectedChats(ctx, entries, [
      { workspace: entries[0], ids: [A] },
      { workspace: entries[0], ids: [A] },
    ]);

    assert.equal(duplicated.error, undefined);

    assert.deepEqual(duplicated.deleted, [
      `${entries[0].workspaceDbPath}: ${A}`,
    ]);
  },
);

test(
  'uppercase composer ids are deleted and unsafe ids or paths are refused',
  { skip },
  async (t) => {
    const { ctx, entries, root, globalDbPath, read, dump } = await setup(t);
    const upper = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';

    await execSqlScript({
      ...ctx,
      database: entries[0].workspaceDbPath,
      sql: `UPDATE ItemTable SET value=${sqlText(JSON.stringify({ allComposers: [A, B, upper].map((composerId) => ({ composerId })), selectedComposerIds: [A, B, upper], lastFocusedComposerIds: [upper] }))} WHERE key='composer.composerData';`,
    });

    await execSqlScript({
      ...ctx,
      database: globalDbPath,
      sql: `INSERT INTO cursorDiskKV VALUES (${sqlText(`composerData:${upper}`)}, '{}'), (${sqlText(`bubbleId:${upper}:message`)}, '{}');`,
    });

    const removed = await deleteSelectedChats(ctx, entries, [
      { workspace: entries[0], ids: [upper] },
    ]);

    assert.equal(removed.error, undefined);
    assert.equal(removed.deleted.length, 1);

    assert.equal(
      (
        await read(
          globalDbPath,
          `SELECT count(*) FROM cursorDiskKV WHERE key=${sqlText(`composerData:${upper}`)};`,
        )
      ).trim(),
      '0',
    );

    assert.match(
      await read(
        entries[0].workspaceDbPath,
        "SELECT value FROM ItemTable WHERE key='composer.composerData';",
      ),
      new RegExp(A),
    );

    const before = await dump();

    const invalid = await deleteSelectedChats(ctx, entries, [
      { workspace: entries[0], ids: ['not-a-uuid'] },
    ]);

    assert.match(invalid.error || '', /Unsupported composer ID/);
    assert.equal(invalid.deleted.length, 0);

    const stranger = {
      ...entries[0],
      workspaceDbPath: `${entries[0].workspaceDbPath}.missing`,
    };

    const unknown = await deleteSelectedChats(ctx, entries, [
      { workspace: stranger, ids: [A] },
    ]);

    assert.match(unknown.error || '', /Workspace storage changed/);

    const wrongStorage = await deleteSelectedChats(ctx, entries, [
      { workspace: { ...entries[0], storageId: 'renamed' }, ids: [A] },
    ]);

    assert.match(wrongStorage.error || '', /Workspace storage changed/);

    const wrongGlobal = await deleteSelectedChats(ctx, entries, [
      {
        workspace: { ...entries[0], globalDbPath: `${globalDbPath}.other` },
        ids: [A],
      },
    ]);

    assert.match(wrongGlobal.error || '', /Workspace storage changed/);

    const link = path.join(root, 'state-link.vscdb');

    await fs.symlink(entries[0].workspaceDbPath, link);

    const linked = {
      ...entries[0],
      workspaceDbPath: link,
    };

    const symlink = await deleteSelectedChats(
      ctx,
      [linked, entries[1]],
      [{ workspace: linked, ids: [A] }],
    );

    assert.match(symlink.error || '', /symbolic links/);

    const samePath = {
      ...entries[0],
      workspaceDbPath: globalDbPath,
      globalDbPath,
    };

    const identical = await deleteSelectedChats(
      ctx,
      [samePath],
      [{ workspace: samePath, ids: [A] }],
    );

    assert.match(
      identical.error || '',
      /Global and workspace databases must be separate/,
    );

    const exec = SqliteSession.prototype.exec;

    t.after(() => {
      SqliteSession.prototype.exec = exec;
    });

    SqliteSession.prototype.exec = async function (sql) {
      if (sql === 'BEGIN IMMEDIATE;') throw 'plain failure';

      return exec.call(this, sql);
    };

    const plain = await deleteSelectedChats(ctx, entries, [
      { workspace: entries[0], ids: [A] },
    ]);

    assert.equal(plain.error, 'plain failure');
    assert.equal(plain.uncertain, undefined);
    assert.equal(plain.deleted.length, 0);
    assert.deepEqual(await dump(), before);
  },
);

for (const mismatch of ['composer-id', 'workspace-id'] as const)
  test(
    `deletion rejects conflicting ${mismatch} columns before any write`,
    { skip },
    async (t) => {
      const { ctx, entries, globalDbPath, read } = await liveWorkspace(t, {
        globalHeaders: [{ composerId: A, storageId: 'migrated' }],
        keys: [`composerData:${A}`, `composerData:${C}`],
      });

      await execSqlScript({
        ...ctx,
        database: globalDbPath,
        sql:
          mismatch === 'composer-id'
            ? `UPDATE composerHeaders SET composerId=${sqlText(C)};`
            : "UPDATE composerHeaders SET workspaceId='other-storage';",
      });

      const before = await read(
        globalDbPath,
        'SELECT composerId,workspaceId,value FROM composerHeaders; SELECT key,value FROM cursorDiskKV ORDER BY key;',
      );

      const result = await deleteSelectedChats(ctx, entries, [
        { workspace: entries[0], ids: [A] },
      ]);

      assert.equal(result.deleted.length, 0);
      assert.match(result.error || '', /Conflicting chat header/);

      assert.equal(
        await read(
          globalDbPath,
          'SELECT composerId,workspaceId,value FROM composerHeaders; SELECT key,value FROM cursorDiskKV ORDER BY key;',
        ),
        before,
      );
    },
  );

test(
  'unknown header schema in another workspace cannot prove exclusive ownership',
  { skip },
  async (t) => {
    const { ctx, entries, globalDbPath, dump } = await setup(t);

    await execSqlScript({
      ...ctx,
      database: entries[1].workspaceDbPath,
      sql: `CREATE TABLE composerHeaders(composerId TEXT PRIMARY KEY, futurePayload BLOB); INSERT INTO composerHeaders VALUES (${sqlText(A)}, '{}');`,
    });

    const before = await dump();

    const result = await deleteSelectedChats(ctx, entries, [
      { workspace: entries[0], ids: [A] },
    ]);

    assert.equal(result.deleted.length, 0);
    assert.match(result.error || '', /Unsupported workspace header schema/);
    assert.deepEqual(await dump(), before);

    assert.equal(
      (
        await execSql({
          ...ctx,
          database: globalDbPath,
          sql: `SELECT count(*) FROM cursorDiskKV WHERE key=${sqlText(`composerData:${A}`)};`,
        })
      ).trim(),
      '1',
    );
  },
);

for (const schema of ['global', 'workspace'] as const)
  test(
    `mixed-case incoming foreign key blocks ${schema} deletion`,
    { skip },
    async (t) => {
      const { ctx, entries, globalDbPath, dump, read } = await setup(t);

      const database =
        schema === 'global' ? globalDbPath : entries[0].workspaceDbPath;

      await execSqlScript({
        ...ctx,
        database,
        sql:
          schema === 'global'
            ? `CREATE TABLE dependent(value TEXT REFERENCES CURSORDISKKV(key) ON DELETE CASCADE); INSERT INTO dependent VALUES (${sqlText(`composerData:${A}`)});`
            : "CREATE TABLE dependent(value TEXT REFERENCES ITEMTABLE(key)); INSERT INTO dependent VALUES ('composer.composerData');",
      });

      const before = await dump();
      const dependent = await read(database, 'SELECT value FROM dependent;');

      const result = await deleteSelectedChats(ctx, entries, [
        { workspace: entries[0], ids: [A] },
      ]);

      assert.equal(result.deleted.length, 0);
      assert.match(result.error || '', /foreign-key dependencies/);
      assert.deepEqual(await dump(), before);

      assert.equal(
        await read(database, 'SELECT value FROM dependent;'),
        dependent,
      );
    },
  );

for (const location of ['global', 'workspace'] as const)
  test(
    `a conflicting ${location} workspace column introduced after preflight aborts deletion`,
    { skip },
    async (t) => {
      const { ctx, entries, globalDbPath, read } = await liveWorkspace(t, {
        globalHeaders: [{ composerId: A, storageId: 'migrated' }],
        localHeaderIds: [A],
        keys: [`composerData:${A}`],
      });

      const exec = SqliteSession.prototype.exec;

      const database =
        location === 'global' ? globalDbPath : entries[0].workspaceDbPath;

      let changed = false;

      t.after(() => {
        SqliteSession.prototype.exec = exec;
      });

      SqliteSession.prototype.exec = async function (statement) {
        if (statement === 'BEGIN IMMEDIATE;' && !changed) {
          changed = true;

          await execSqlScript({
            ...ctx,
            database,
            sql: "UPDATE composerHeaders SET workspaceId='another-window';",
          });
        }

        return exec.call(this, statement);
      };

      const result = await deleteSelectedChats(ctx, entries, [
        { workspace: entries[0], ids: [A] },
      ]);

      assert.equal(changed, true);
      assert.match(result.error || '', /Conflicting chat header/);
      assert.equal(result.deleted.length, 0);

      assert.equal(
        (
          await read(
            globalDbPath,
            `SELECT count(*) FROM cursorDiskKV WHERE key=${sqlText(`composerData:${A}`)};`,
          )
        ).trim(),
        '1',
      );

      assert.equal(
        (
          await read(database, 'SELECT workspaceId FROM composerHeaders;')
        ).trim(),
        'another-window',
      );
    },
  );

for (const field of ['selectedComposerIds', 'lastFocusedComposerIds'] as const)
  test(
    `a migrated workspace's ${field} alone prevents deleting shared message bodies`,
    { skip },
    async (t) => {
      const { ctx, entries, dump } = await setup(t);

      await execSqlScript({
        ...ctx,
        database: entries[1].workspaceDbPath,
        sql: `UPDATE ItemTable SET value=${sqlText(JSON.stringify({ hasMigratedComposerData: true, [field]: [A] }))} WHERE key='composer.composerData';`,
      });

      const before = await dump();

      const result = await deleteSelectedChats(ctx, entries, [
        { workspace: entries[0], ids: [A] },
      ]);

      assert.equal(result.deleted.length, 0);
      assert.equal(result.skipped.length, 1);
      assert.equal(result.error, undefined);
      assert.deepEqual(await dump(), before);
    },
  );

test(
  'ownership-only references do not create rows in normal workspace listings',
  { skip },
  async (t) => {
    const { ctx, entries, globalDbPath } = await setup(t);

    await execSqlScript({
      ...ctx,
      database: globalDbPath,
      sql: "UPDATE ItemTable SET value='{\"allComposers\":[]}' WHERE key='composer.composerHeaders';",
    });

    await execSqlScript({
      ...ctx,
      database: entries[0].workspaceDbPath,
      sql: `UPDATE ItemTable SET value=${sqlText(JSON.stringify({ hasMigratedComposerData: true, selectedComposerIds: [A], lastFocusedComposerIds: [A] }))} WHERE key='composer.composerData';`,
    });

    const { WorkspaceHeaderReader } =
      await import('../src/workspace-header-reader');

    const reader = new WorkspaceHeaderReader(ctx);

    assert.deepEqual(await reader.read(entries[0]), []);

    assert.deepEqual(
      (await reader.read(entries[0], true)).map((row) => row.composerId),
      [A],
    );
  },
);
