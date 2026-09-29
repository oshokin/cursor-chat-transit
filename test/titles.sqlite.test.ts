import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as db from '../src/db';
import { sqlText } from '../src/core';
import * as transfer from '../src/transfer';
import * as sql from '../src/sqlite';
import { assertExportShape, readJsonFile } from '../src/format';
import {
  selectionForFilename,
  suggestExportFilename,
} from '../src/export-name';
import type {
  ComposerHeader,
  TransferContext,
  WorkspaceEntry,
  WorkspaceIdentity,
} from '../src/types';

/** First chat used in title round-trips. */
const A = '11111111-1111-4111-8111-111111111111';
/** Second chat used when two titles collide. */
const B = '22222222-2222-4222-8222-222222222222';
/** Shared bubble id in title fixtures. */
const bubble = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
/** sqlite3 CLI used by these tests; undefined skips the suite. */
const executable = sql.findSqliteExecutable(process.env.SQLITE3_PATH);
/** Skip message when sqlite3 is not on PATH. */
const skip = executable
  ? false
  : 'sqlite3 CLI is required for title regressions';

/** Synthetic local workspace identity. */
const identity: WorkspaceIdentity = {
  kind: 'folder',
  uri: {
    scheme: 'file',
    authority: '',
    path: '/synthetic',
    query: '',
    fragment: '',
  },
};

/** Composer body JSON, optionally including a name. */
function bodyOf(id: string, name?: string) {
  return JSON.stringify({ composerId: id, ...(name ? { name } : {}) });
}

/** One bubble record whose text can carry the chat title. */
function bubbleOf(id: string, name?: string) {
  return {
    key: `bubbleId:${id}:${bubble}`,
    bubbleId: bubble,
    value: JSON.stringify({
      composerId: id,
      bubbleId: bubble,
      text: name || 'synthetic',
    }),
  };
}

/** Throwaway databases for title export/import tests. */
async function fixture(
  t: { after: (fn: () => Promise<void>) => void },
  opts?: { headers?: boolean },
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cct-title-'));
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
INSERT INTO ItemTable VALUES('composer.composerHeaders','{"allComposers":[]}');`,
  });
  const headerTable = opts?.headers
    ? `CREATE TABLE composerHeaders(composerId TEXT PRIMARY KEY,workspaceId TEXT,value BLOB);`
    : '';
  await sql.execSqlScript({
    ...ws,
    sql: `PRAGMA journal_mode=WAL;
CREATE TABLE ItemTable(key TEXT PRIMARY KEY,value BLOB);
${headerTable}`,
  });
  return { dir, ctx, workspace, gl, ws };
}

/** Insert one titled chat into the global database. */
async function seedChat(
  gl: { executable: string; database: string; initFile: string },
  header: ComposerHeader,
) {
  await sql.execSqlScript({
    ...gl,
    sql: db.kvInsertSql([
      {
        key: `composerData:${header.composerId}`,
        value: bodyOf(header.composerId, header.name),
      },
      {
        key: `bubbleId:${header.composerId}:${bubble}`,
        value: bubbleOf(header.composerId, header.name).value,
      },
    ]),
  });
}

test(
  'SQLite table header without name keeps the workspace title in the export file',
  { skip },
  async (t) => {
    const title = 'Починить SSH ✨';
    const { dir, ctx, workspace, gl, ws } = await fixture(t, {
      headers: true,
    });
    await seedChat(gl, { composerId: A, name: title });
    await sql.execSqlScript({
      ...ws,
      sql: `${db.itemReplaceSql('composer.composerData', {
        allComposers: [{ composerId: A, name: title, createdAt: 7 }],
      })}
INSERT INTO composerHeaders(composerId,workspaceId,value) VALUES(
  ${sqlText(A)},
  ${sqlText('fixture')},
  ${sqlText(JSON.stringify({ composerId: A, lastUpdatedAt: 9 }))}
);`,
    });
    const dest = path.join(dir, 'export.json');
    await transfer.exportToFile(ctx, workspace, dest);
    const exported = assertExportShape(await readJsonFile(dest));
    assert.equal(exported.allComposers[0].name, title);
    assert.equal(exported.allComposers[0].lastUpdatedAt, 9);
    assert.equal(exported.allComposers[0].createdAt, undefined);
    assert.equal(JSON.parse(exported.composers[A] as string).name, title);
  },
);

test(
  'unicode title round-trips through export and import without rewriting',
  { skip },
  async (t) => {
    const title = '  Починить SSH ✨  ';
    const src = await fixture(t);
    await seedChat(src.gl, { composerId: A, name: title, createdAt: 7 });
    await sql.execSqlScript({
      ...src.ws,
      sql: db.itemReplaceSql('composer.composerData', {
        allComposers: [
          {
            composerId: A,
            name: title,
            createdAt: 7,
            lastUpdatedAt: 9,
          },
        ],
      }),
    });
    const destPath = path.join(src.dir, 'unicode.json');
    await transfer.exportToFile(src.ctx, src.workspace, destPath);
    const exported = assertExportShape(await readJsonFile(destPath));
    assert.equal(exported.allComposers[0].name, title);

    const dest = await fixture(t);
    const result = await transfer.importFromObject(
      dest.ctx,
      exported,
      dest.workspace,
    );
    assert.equal(result.imported, 1);
    const listed = await transfer.listWorkspaceChats(dest.ctx, dest.workspace);
    assert.equal(listed.allComposers.length, 1);
    assert.notEqual(listed.allComposers[0].composerId, A);
    assert.equal(listed.allComposers[0].name, title);
    assert.equal(listed.allComposers[0].createdAt, 7);
    assert.equal(listed.allComposers[0].lastUpdatedAt, 9);
    assert.equal(listed.allComposers[0].workspaceIdentifier?.id, 'fixture');
  },
);

test(
  'a numeric chat title is preserved and is not turned into a date',
  { skip },
  async (t) => {
    const title = '1790418430150';
    const src = await fixture(t);
    await seedChat(src.gl, { composerId: A, name: title });
    await sql.execSqlScript({
      ...src.ws,
      sql: db.itemReplaceSql('composer.composerData', {
        allComposers: [{ composerId: A, name: title }],
      }),
    });
    const destPath = path.join(src.dir, 'numeric.json');
    await transfer.exportToFile(src.ctx, src.workspace, destPath);
    const exported = assertExportShape(await readJsonFile(destPath));
    assert.equal(exported.allComposers[0].name, title);
    const dest = await fixture(t);
    await transfer.importFromObject(dest.ctx, exported, dest.workspace);
    const listed = await transfer.listWorkspaceChats(dest.ctx, dest.workspace);
    assert.equal(listed.allComposers[0].name, title);
    assert.doesNotMatch(String(listed.allComposers[0].name), /2026/);
  },
);

test(
  'selecting one of two same-titled chats exports that chat and names the file from it',
  { skip },
  async (t) => {
    const title = 'Same title';
    const { dir, ctx, workspace, gl, ws } = await fixture(t);
    await seedChat(gl, { composerId: A, name: title });
    await seedChat(gl, { composerId: B, name: title });
    await sql.execSqlScript({
      ...ws,
      sql: db.itemReplaceSql('composer.composerData', {
        allComposers: [
          { composerId: A, name: title },
          { composerId: B, name: title },
        ],
      }),
    });
    const dest = path.join(dir, 'one.json');
    await transfer.exportToFile(ctx, workspace, dest, [B]);
    const exported = assertExportShape(await readJsonFile(dest));
    assert.equal(exported.allComposers.length, 1);
    assert.equal(exported.allComposers[0].composerId, B);
    assert.equal(exported.allComposers[0].name, title);
    const filename = suggestExportFilename({
      workspaceName: 'synthetic',
      selection: selectionForFilename('selected', exported.allComposers),
      now: new Date('2026-09-27T13:42:45.123Z'),
    });
    assert.match(filename, /Same-title/);
    assert.doesNotMatch(filename, /2-chats/);
  },
);
