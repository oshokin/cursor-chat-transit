import test from 'node:test';
import assert from 'node:assert/strict';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sqlText } from '../src/core';
import {
  executeManagedDelete,
  findEmptyWorkspaces,
  prepareManagedDelete,
} from '../src/managed-delete-run';
import { execSql, execSqlScript } from '../src/sqlite';
import type { TransferContext, WorkspaceEntry } from '../src/types';
import { assessWorkspaceHistory } from '../src/workspace-history';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const TALK = '33333333-3333-4333-8333-333333333333';
const ODD = '55555555-5555-4555-8555-555555555555';
const NUMERIC = '1776351039511';

const HEADER_TABLE = `CREATE TABLE composerHeaders (
  composerId TEXT PRIMARY KEY,
  workspaceId TEXT,
  createdAt INTEGER,
  lastUpdatedAt INTEGER,
  isArchived INTEGER,
  isSubagent INTEGER,
  recency INTEGER,
  checkpointAt INTEGER,
  value TEXT,
  subagentTypeName TEXT
)`;

/** Header JSON using the columns stored in a live Cursor profile. */
function headerValue(composerId: string, workspaceId: string): string {
  return JSON.stringify({
    type: 'head',
    composerId,
    createdAt: 1780000000000,
    lastUpdatedAt: 1780000001000,
    unifiedMode: 'agent',
    isArchived: false,
    isDraft: false,
    isSubagent: false,
    workspaceIdentifier: { id: workspaceId },
  });
}

/** Insert one composerHeaders row. The JSON id can disagree with the column. */
function headerInsert(
  composerId: string,
  workspaceId: string,
  jsonWorkspaceId = workspaceId,
  subagent: string | null = null,
): string {
  return `INSERT INTO composerHeaders VALUES (${sqlText(composerId)}, ${sqlText(workspaceId)}, 1780000000000, 1780000001000, 0, 0, 1, NULL, ${sqlText(headerValue(composerId, jsonWorkspaceId))}, ${subagent === null ? 'NULL' : sqlText(subagent)});`;
}

/** Global database shaped like the live profile, plus two workspace directories. */
async function liveProfile(): Promise<{
  root: string;
  ctx: TransferContext;
  globalDbPath: string;
  old: WorkspaceEntry;
  shell: WorkspaceEntry;
  talk: WorkspaceEntry;
  project: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cct-live-schema-'));

  const ctx: TransferContext = {};

  const globalDbPath = path.join(root, 'User', 'globalStorage', 'state.vscdb');
  const project = path.join(root, 'projects', 'repo', 'sentinel');

  await mkdir(path.dirname(globalDbPath), { recursive: true });
  await mkdir(path.dirname(project), { recursive: true });
  await writeFile(project, 'project');

  await execSqlScript({
    ...ctx,
    database: globalDbPath,
    sql: `PRAGMA journal_mode=WAL;
CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
${HEADER_TABLE};
${headerInsert('empty-state-draft', 'oldstore')};
${headerInsert(A, 'shellstore', 'shellstore', 'explore')};
${headerInsert(B, NUMERIC)};
INSERT INTO cursorDiskKV VALUES
  ('composerData:${A}','{}'),
  ('composerRootWriterDiagnostic:${A}','diag'),
  ('agentKv:blob:keep','blob'),
  ('composer.content.abc','body'),
  ('bubbleId:${B}:m','{"text":"keep"}'),
  ('checkpointId:${B}:x','cp');`,
  });

  /** Workspace directory. `modern` matches a current local database. */
  async function workspace(
    storageId: string,
    modern: boolean,
    composerData?: string,
  ): Promise<WorkspaceEntry> {
    const directory = path.join(root, 'User', 'workspaceStorage', storageId);
    const workspaceDbPath = path.join(directory, 'state.vscdb');

    await mkdir(directory, { recursive: true });

    const composer = composerData
      ? `INSERT INTO ItemTable VALUES ('composer.composerData',${sqlText(composerData)});`
      : `INSERT INTO ItemTable VALUES ('history.entries','[]');`;

    const extra = modern
      ? `CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
${HEADER_TABLE};`
      : '';

    await execSqlScript({
      ...ctx,
      database: workspaceDbPath,
      sql: `PRAGMA journal_mode=WAL;
CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
${extra}
${composer}`,
    });

    return {
      storageRoot: root,
      storageId,
      key: storageId,
      mtime: 0,
      globalDbPath,
      workspaceDbPath,
      identity: {
        kind: 'folder',
        uri: { scheme: 'file', authority: '', path: path.dirname(project) },
      },
    };
  }

  const migrated = JSON.stringify({
    selectedComposerIds: [],
    lastFocusedComposerIds: [],
    hasMigratedComposerData: true,
    hasMigratedMultipleComposers: true,
  });

  const old = await workspace('oldstore', false);
  const shell = await workspace('shellstore', true, migrated);
  const talk = await workspace('talkstore', true, migrated);

  await execSqlScript({
    ...ctx,
    database: globalDbPath,
    sql: `${headerInsert(TALK, 'talkstore')};
INSERT INTO cursorDiskKV VALUES ('bubbleId:${TALK}:m','{"text":"hi"}');`,
  });

  return { root, ctx, globalDbPath, old, shell, talk, project };
}

test('a live composerHeaders table distinguishes empty, present, and conflicting rows', async () => {
  const { root, ctx, old, shell, talk } = await liveProfile();

  try {
    assert.equal((await assessWorkspaceHistory(ctx, old)).state, 'empty');
    assert.equal((await assessWorkspaceHistory(ctx, shell)).state, 'empty');
    assert.equal((await assessWorkspaceHistory(ctx, talk)).state, 'present');

    const scan = await findEmptyWorkspaces(ctx, {
      kind: 'find-empty-workspaces',
      ...ctx,
      userDataRoot: root,
      workspaces: [old, shell, talk],
      emptyWindow: true,
    });

    assert.deepEqual(scan.selected.map((entry) => entry.storageId).sort(), [
      'oldstore',
      'shellstore',
    ]);

    assert.equal(scan.unchecked, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('deleting an old workspace leaves numeric headers and unrelated global keys', async () => {
  const { root, ctx, globalDbPath, old, shell, talk, project } =
    await liveProfile();

  try {
    const prepared = await prepareManagedDelete(ctx, {
      kind: 'prepare-managed-delete',
      ...ctx,
      userDataRoot: root,
      requests: [old, shell].map((workspace) => ({
        kind: 'workspace-data' as const,
        workspace,
        requireEmpty: true as const,
      })),
      workspaces: [old, shell, talk],
      emptyWindow: true,
    });

    assert.equal(prepared.ok, true, JSON.stringify(prepared));
    if (!prepared.ok) return;

    const result = await executeManagedDelete(ctx, {
      kind: 'delete-managed-data',
      ...ctx,
      plan: prepared.plan,
      workspaces: [old, shell, talk],
      emptyWindow: true,
    });

    assert.equal(
      result.outcomes.every((outcome) => outcome.storage === 'deleted'),
      true,
      JSON.stringify(result),
    );

    await assert.rejects(lstat(old.workspaceDbPath));
    await assert.rejects(lstat(shell.workspaceDbPath));
    await lstat(talk.workspaceDbPath);
    assert.equal(await readFile(project, 'utf8'), 'project');

    const headers = await execSql({
      ...ctx,
      database: globalDbPath,
      readOnly: true,
      sql: `SELECT composerId || '=' || workspaceId FROM composerHeaders ORDER BY composerId;`,
    });

    assert.match(headers, /empty-state-draft=oldstore/);
    assert.match(headers, new RegExp(`${B}=${NUMERIC}`));
    assert.doesNotMatch(headers, new RegExp(`^${A}=`, 'm'));

    const kept = await execSql({
      ...ctx,
      database: globalDbPath,
      readOnly: true,
      sql: `SELECT count(*) FROM cursorDiskKV WHERE key IN ('agentKv:blob:keep','composer.content.abc','bubbleId:${B}:m','checkpointId:${B}:x');`,
    });

    assert.equal(kept.trim(), '4');

    const removed = await execSql({
      ...ctx,
      database: globalDbPath,
      readOnly: true,
      sql: `SELECT count(*) FROM cursorDiskKV WHERE key IN ('composerData:${A}','composerRootWriterDiagnostic:${A}');`,
    });

    assert.equal(removed.trim(), '0');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a composerHeaders column that disagrees with its JSON is not empty', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cct-live-odd-'));

  const ctx: TransferContext = {};

  const globalDbPath = path.join(root, 'User', 'globalStorage', 'state.vscdb');

  const directory = path.join(root, 'User', 'workspaceStorage', 'oddstore');
  const workspaceDbPath = path.join(directory, 'state.vscdb');

  try {
    await mkdir(path.dirname(globalDbPath), { recursive: true });
    await mkdir(directory, { recursive: true });

    await execSqlScript({
      ...ctx,
      database: globalDbPath,
      sql: `PRAGMA journal_mode=WAL;
CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
${HEADER_TABLE};
${headerInsert(ODD, 'oddstore', NUMERIC)};`,
    });

    await execSqlScript({
      ...ctx,
      database: workspaceDbPath,
      sql: `PRAGMA journal_mode=WAL;
CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
${HEADER_TABLE};
INSERT INTO ItemTable VALUES ('composer.composerData','{"selectedComposerIds":[],"lastFocusedComposerIds":[]}');`,
    });

    const odd: WorkspaceEntry = {
      storageRoot: root,
      storageId: 'oddstore',
      key: 'oddstore',
      mtime: 0,
      globalDbPath,
      workspaceDbPath,
      identity: {
        kind: 'folder',
        uri: { scheme: 'file', authority: '', path: '/tmp/odd' },
      },
    };

    assert.equal((await assessWorkspaceHistory(ctx, odd)).state, 'unavailable');

    const scan = await findEmptyWorkspaces(ctx, {
      kind: 'find-empty-workspaces',
      ...ctx,
      userDataRoot: root,
      workspaces: [odd],
      emptyWindow: true,
    });

    assert.deepEqual(scan.selected, []);
    assert.equal(scan.unchecked, 1);
    await lstat(workspaceDbPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
