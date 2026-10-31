import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as db from '../src/db';
import * as dep from '../src/dependencies';
import * as sql from '../src/sqlite';
import { findSqliteExecutable } from './support/sqlite-cli';
import * as transfer from '../src/transfer';
import { acquireLock } from '../src/lock';
import { encodePlan } from '../src/plans';
import { sqlText } from '../src/core';
import { sha256Text } from '../src/import-policy';
import {
  journalPathFor,
  loadJournal,
  saveJournal,
  targetKeyFor,
} from '../src/journal';
import { JournalStore } from '../src/journal-db';
import { TransferError } from '../src/types';
import type {
  ExportObject,
  TransferContext,
  WorkspaceEntry,
  WorkspaceIdentity,
} from '../src/types';

/** Source composer used as the original snapshot. */
const A = '11111111-1111-4111-8111-111111111111';
/** Second composer used in later-batch tests. */
const B = '22222222-2222-4222-8222-222222222222';
/** Spare bubble id for payload builders. */
const X = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
/** sqlite3 CLI used by these tests; undefined skips the suite. */
const executable = findSqliteExecutable(process.env.SQLITE3_PATH);

/** Skip message when sqlite3 is not on PATH. */
const skip = executable
  ? false
  : 'sqlite3 CLI is required for repeat-import tests';

/** Format-3 export object for the given composer ids. */
function payload(
  ids: Array<{
    /** Source composer id. */
    id: string;
    /** Display title used in the fixture body. */
    name: string;
    /** Extra body field used to change the snapshot hash. */
    extra?: string;
  }> = [{ id: A, name: 'Original title' }],
) {
  return {
    formatVersion: 3,
    allComposers: ids.map((row) => ({ composerId: row.id, name: row.name })),
    composers: Object.fromEntries(
      ids.map((row) => [
        row.id,
        JSON.stringify({
          _v: 18,
          composerId: row.id,
          name: row.name,
          extra: row.extra,
          fullConversationHeadersOnly: [],
        }),
      ]),
    ),
    bubbles: Object.fromEntries(ids.map((row) => [row.id, []] as const)),
    resources: { kv: [], attachments: [], plans: [] },
  };
}

/** Fixture whose source composer selects one model. */
function modelPayload(modelId: string) {
  const value = payload();
  const body = JSON.parse(value.composers[A]!) as Record<string, unknown>;

  body.modelConfig = {
    modelName: modelId,
    maxMode: false,
    selectedModels: [
      {
        modelId,
        parameters: [{ id: 'effort', value: 'high' }],
      },
    ],
  };

  body.stateMarker = 'unchanged-state';
  value.composers[A] = JSON.stringify(body);

  return value;
}

/** Destination policy that exposes only the named current model. */
function withModelPolicy(
  ctx: TransferContext,
  modelId: string,
): TransferContext {
  return {
    ...ctx,
    modelImportPolicy: {
      availableModelIds: ['default', modelId],
      fallback: {
        modelName: modelId,
        maxMode: false,
        selectedModels: [{ modelId, parameters: [] }],
      },
    },
  };
}

/** Throwaway destination databases and journal directory. */
async function setup(
  t: {
    /** Register cleanup that deletes the throwaway directory. */
    after: (fn: () => Promise<void>) => void;
  },
  identity: WorkspaceIdentity = {
    kind: 'folder',
    uri: { scheme: 'file', authority: '', path: '/fixture' },
  },
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'transit-repeat-'));

  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const ctx: TransferContext = {};

  const workspace: WorkspaceEntry = {
    storageRoot: dir,
    storageId: 'target',
    key: 'target',
    mtime: 0,
    identity,
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

  return { ctx, workspace, gl, ws, dir };
}

/** Stored ItemTable cell, including SQL NULL and an empty string. */
async function storedItem(
  conn: TransferContext & { database: string },
  key: string,
): Promise<{ type: string; text: string | null }> {
  const line = (
    await sql.execSql({
      ...conn,
      sql: `SELECT typeof(value), hex(value) FROM ItemTable WHERE key = ${sqlText(key)};`,
    })
  ).replace(/\r?\n$/, '');

  const tab = line.indexOf('\t');
  const type = tab < 0 ? line : line.slice(0, tab);
  const hex = tab < 0 ? '' : line.slice(tab + 1);

  return {
    type,
    text: type === 'null' ? null : Buffer.from(hex, 'hex').toString('utf8'),
  };
}

/** Count composerData rows in the destination global database. */
async function bodyCount(gl: TransferContext & { database: string }) {
  return Number(
    (
      await sql.execSql({
        ...gl,
        sql: "SELECT count(*) FROM cursorDiskKV WHERE key GLOB 'composerData:*';",
      })
    ).trim(),
  );
}

/** Count backup files written beside the destination databases. */
async function backupCount(workspace: WorkspaceEntry) {
  const dir = path.join(
    path.dirname(workspace.globalDbPath),
    'cursor-chat-transit-backups',
  );

  try {
    return (await fs.readdir(dir)).length;
  } catch {
    return 0;
  }
}

test(
  'repeat import must not create a second copy of the same snapshot',
  { skip },
  async (t) => {
    const { ctx, workspace, gl } = await setup(t);

    await transfer.importFromObject(ctx, payload(), workspace);
    const second = await transfer.importFromObject(ctx, payload(), workspace);

    assert.equal(await bodyCount(gl), 1);
    assert.equal(second.imported, 0);
    assert.equal(second.alreadyImported, 1);
  },
);

test(
  'import assigns one target turn to standalone canonical rows without an unsuffixed root',
  { skip },
  async (t) => {
    const { ctx, workspace, gl } = await setup(t);
    const source = payload() as unknown as ExportObject;
    const turn = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const sourceIds = [`${turn}/s:0`, `${turn}/t:call`, `${turn}/t2:call`];
    const body = JSON.parse(source.composers[A]!) as Record<string, unknown>;

    body.fullConversationHeadersOnly = sourceIds.map((bubbleId) => ({
      bubbleId,
      type: 2,
    }));

    source.composers[A] = JSON.stringify(body);

    source.bubbles![A] = sourceIds.map((bubbleId) => ({
      key: `bubbleId:${A}:${bubbleId}`,
      bubbleId,
      value: JSON.stringify({ _v: 3, bubbleId, type: 2, text: bubbleId }),
    }));

    const result = await transfer.importFromObject(ctx, source, workspace);

    const targetComposer = (
      await sql.execSql({
        ...gl,
        sql: "SELECT substr(key, 14) FROM cursorDiskKV WHERE key GLOB 'composerData:*' LIMIT 1;",
      })
    ).trim();

    const targetIds = (
      await sql.execSql({
        ...gl,
        sql: `SELECT substr(key, ${'bubbleId:'.length + targetComposer.length + 2}) FROM cursorDiskKV WHERE key >= ${sqlText(`bubbleId:${targetComposer}:`)} AND key < ${sqlText(`bubbleId:${targetComposer};`)} ORDER BY key;`,
      })
    )
      .trim()
      .split(/\r?\n/);

    const roots = new Set(targetIds.map((id) => id.slice(0, id.indexOf('/'))));

    assert.equal(result.imported, 1);
    assert.equal(targetIds.length, 3);
    assert.equal(roots.size, 1);

    assert.deepEqual(
      targetIds.map((id) => id.slice(id.indexOf('/') + 1)),
      ['s:0', 't2:call', 't:call'],
    );
  },
);

test(
  'repeat import restores a legacy copy whose opaque state kept the source id',
  { skip },
  async (t) => {
    const { ctx, workspace, gl } = await setup(t);
    const source = payload();
    const body = JSON.parse(source.composers[A]) as Record<string, unknown>;

    const state = Buffer.concat([
      Buffer.from([0xa2, 0x06, Buffer.byteLength(A)]),
      Buffer.from(A),
    ]);

    body.conversationState = `~${state.toString('base64')}`;
    source.composers[A] = JSON.stringify(body);
    const first = await transfer.importFromObject(ctx, source, workspace);
    const firstId = first.composerIds[0]!;

    const stored = JSON.parse(
      (await db.readKvText(gl, `composerData:${firstId}`)) || '{}',
    ) as Record<string, unknown>;

    stored.conversationState = body.conversationState;

    await sql.execSqlScript({
      ...gl,
      sql: `UPDATE cursorDiskKV SET value=${sqlText(JSON.stringify(stored))} WHERE key=${sqlText(`composerData:${firstId}`)};`,
    });

    const second = await transfer.importFromObject(ctx, source, workspace);

    assert.equal(second.imported, 1);
    assert.notEqual(second.composerIds[0], firstId);
    assert.equal(await bodyCount(gl), 2);
  },
);

test(
  'new import replaces only an unavailable model config',
  { skip },
  async (t) => {
    const { ctx, workspace, gl } = await setup(t);

    const result = await transfer.importFromObject(
      withModelPolicy(ctx, 'target-custom'),
      modelPayload('source-custom'),
      workspace,
    );

    const stored = JSON.parse(
      (await db.readKvText(gl, `composerData:${result.composerIds[0]}`)) ||
        '{}',
    ) as {
      modelConfig?: { modelName?: string };
      stateMarker?: string;
    };

    assert.equal(stored.modelConfig?.modelName, 'target-custom');
    assert.equal(stored.stateMarker, 'unchanged-state');
  },
);

test(
  'new import preserves an available model config including unknown fields',
  { skip },
  async (t) => {
    const { ctx, workspace, gl } = await setup(t);
    const source = modelPayload('source-custom');

    const sourceBody = JSON.parse(source.composers[A]!) as {
      modelConfig: Record<string, unknown>;
    };

    sourceBody.modelConfig.future = { preserved: true };
    source.composers[A] = JSON.stringify(sourceBody);

    const result = await transfer.importFromObject(
      withModelPolicy(ctx, 'source-custom'),
      source,
      workspace,
    );

    const stored = JSON.parse(
      (await db.readKvText(gl, `composerData:${result.composerIds[0]}`)) ||
        '{}',
    ) as { modelConfig?: unknown };

    assert.deepEqual(stored.modelConfig, sourceBody.modelConfig);
  },
);

test(
  'repeat import repairs the archived unavailable model in the existing copy',
  { skip },
  async (t) => {
    const { ctx, workspace, gl } = await setup(t);
    const source = modelPayload('source-custom');
    const first = await transfer.importFromObject(ctx, source, workspace);
    const id = first.composerIds[0]!;

    const second = await transfer.importFromObject(
      withModelPolicy(ctx, 'target-custom'),
      source,
      workspace,
    );

    const stored = JSON.parse(
      (await db.readKvText(gl, `composerData:${id}`)) || '{}',
    ) as {
      modelConfig?: { modelName?: string };
      stateMarker?: string;
    };

    assert.equal(second.imported, 0);
    assert.equal(second.modelConfigsRepaired, 1);
    assert.equal(stored.modelConfig?.modelName, 'target-custom');
    assert.equal(stored.stateMarker, 'unchanged-state');

    const journal = await JournalStore.open({
      journalDir: path.join(workspace.storageRoot, 'cursor-chat-transit'),
      targetKey: await targetKeyFor(workspace),
    });

    const receipts = await journal.receipts();

    const projection = await journal.projection({
      sourceComposerId: A,
      snapshotHash: receipts[0]!.snapshotHash,
      targetComposerId: id,
    });

    await journal.close();
    assert.equal(receipts.length, 1);
    assert.equal(projection?.projectionVersion, 'model-compat-v2');
    assert.equal(projection?.outcome, 'applied');
  },
);

test(
  'repeat projection is idempotent and does not mint another chat',
  { skip },
  async (t) => {
    const { ctx, workspace, gl } = await setup(t);
    const source = modelPayload('source-custom');

    await transfer.importFromObject(ctx, source, workspace);

    const repaired = await transfer.importFromObject(
      withModelPolicy(ctx, 'target-custom'),
      source,
      workspace,
    );

    const repeated = await transfer.importFromObject(
      withModelPolicy(ctx, 'target-custom'),
      source,
      workspace,
    );

    assert.equal(repaired.modelConfigsRepaired, 1);
    assert.equal(repeated.modelConfigsRepaired, 0);
    assert.equal(repeated.alreadyImported, 1);
    assert.equal(await bodyCount(gl), 1);
  },
);

test(
  'repeat import does not overwrite a model selected after import',
  { skip },
  async (t) => {
    const { ctx, workspace, gl } = await setup(t);
    const source = modelPayload('source-custom');
    const first = await transfer.importFromObject(ctx, source, workspace);
    const id = first.composerIds[0]!;
    const key = `composerData:${id}`;

    const body = JSON.parse((await db.readKvText(gl, key)) || '{}') as Record<
      string,
      unknown
    >;

    body.modelConfig = {
      modelName: 'manually-selected',
      maxMode: false,
      selectedModels: [{ modelId: 'manually-selected', parameters: [] }],
    };

    await sql.execSqlScript({
      ...gl,
      sql: `UPDATE cursorDiskKV SET value=${sqlText(JSON.stringify(body))} WHERE key=${sqlText(key)};`,
    });

    const second = await transfer.importFromObject(
      withModelPolicy(ctx, 'target-custom'),
      source,
      workspace,
    );

    const stored = JSON.parse((await db.readKvText(gl, key)) || '{}') as {
      modelConfig?: { modelName?: string };
    };

    assert.equal(second.modelConfigsRepaired, 0);
    assert.equal(stored.modelConfig?.modelName, 'manually-selected');
  },
);

test(
  'reformatted JSON of the same chat is still a no-op',
  { skip },
  async (t) => {
    const { ctx, workspace, gl } = await setup(t);

    await transfer.importFromObject(ctx, payload(), workspace);
    const src = payload();

    const reshaped = {
      resources: src.resources,
      bubbles: src.bubbles,
      composers: src.composers,
      allComposers: src.allComposers,
      formatVersion: src.formatVersion,
    };

    const second = await transfer.importFromObject(ctx, reshaped, workspace);

    assert.equal(await bodyCount(gl), 1);
    assert.equal(second.alreadyImported, 1);
  },
);

test(
  'a later batch only creates the chat that was not imported yet',
  { skip },
  async (t) => {
    const { ctx, workspace, gl } = await setup(t);

    await transfer.importFromObject(
      ctx,
      payload([{ id: A, name: 'A' }]),
      workspace,
    );

    const result = await transfer.importFromObject(
      ctx,
      payload([
        { id: A, name: 'A' },
        { id: B, name: 'B' },
      ]),
      workspace,
    );

    assert.equal(await bodyCount(gl), 2);
    assert.equal(result.imported, 1);
    assert.equal(result.alreadyImported, 1);
  },
);

test('two chats with the same title are both imported', { skip }, async (t) => {
  const { ctx, workspace, gl } = await setup(t);

  const result = await transfer.importFromObject(
    ctx,
    payload([
      { id: A, name: 'Same' },
      { id: B, name: 'Same' },
    ]),
    workspace,
  );

  assert.equal(result.imported, 2);
  assert.equal(await bodyCount(gl), 2);
});

test(
  'the same snapshot in another workspace identity is imported independently',
  { skip },
  async (t) => {
    const first = await setup(t, {
      kind: 'folder',
      uri: { scheme: 'file', authority: '', path: '/one' },
    });

    const secondDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'transit-repeat-b-'),
    );

    t.after(() => fs.rm(secondDir, { recursive: true, force: true }));

    const workspace: WorkspaceEntry = {
      ...first.workspace,
      storageRoot: secondDir,
      storageId: 'other',
      identity: {
        kind: 'folder',
        uri: { scheme: 'file', authority: '', path: '/two' },
      },
      globalDbPath: path.join(secondDir, 'global.vscdb'),
      workspaceDbPath: path.join(secondDir, 'workspace.vscdb'),
    };

    const gl2 = { ...first.ctx, database: workspace.globalDbPath };
    const ws2 = { ...first.ctx, database: workspace.workspaceDbPath };

    await sql.execSqlScript({
      ...gl2,
      sql: `PRAGMA journal_mode=WAL;
CREATE TABLE ItemTable(key TEXT PRIMARY KEY,value BLOB);
CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY,value BLOB);
INSERT INTO ItemTable VALUES('composer.composerHeaders','{"allComposers":[]}');`,
    });

    await sql.execSqlScript({
      ...ws2,
      sql: 'PRAGMA journal_mode=WAL; CREATE TABLE ItemTable(key TEXT PRIMARY KEY,value BLOB);',
    });

    await transfer.importFromObject(first.ctx, payload(), first.workspace);
    await transfer.importFromObject(first.ctx, payload(), workspace);
    assert.equal(await bodyCount(first.gl), 1);
    assert.equal(await bodyCount(gl2), 1);
  },
);

test(
  'continuing the target copy does not overwrite it on a repeat import',
  { skip },
  async (t) => {
    const { ctx, workspace, gl } = await setup(t);
    const first = await transfer.importFromObject(ctx, payload(), workspace);
    const id = first.composerIds[0]!;
    const raw = await db.readKvText(gl, `composerData:${id}`);
    const body = JSON.parse(raw || '{}') as Record<string, unknown>;

    body.continued = true;
    const encoded = JSON.stringify(body).replace(/'/g, "''");

    await sql.execSqlScript({
      ...gl,
      sql: `UPDATE cursorDiskKV SET value='${encoded}' WHERE key='composerData:${id}';`,
    });

    const second = await transfer.importFromObject(ctx, payload(), workspace);

    assert.equal(second.alreadyImported, 1);
    assert.equal(await bodyCount(gl), 1);

    const kept = JSON.parse(
      (await db.readKvText(gl, `composerData:${id}`)) || '{}',
    ) as { continued?: boolean };

    assert.equal(kept.continued, true);
  },
);

test(
  'a changed source snapshot is added as a separate copy',
  { skip },
  async (t) => {
    const { ctx, workspace, gl } = await setup(t);

    await transfer.importFromObject(
      ctx,
      payload([{ id: A, name: 'Original' }]),
      workspace,
    );

    const changed = payload([{ id: A, name: 'Edited', extra: 'v2' }]);
    const result = await transfer.importFromObject(ctx, changed, workspace);

    assert.equal(result.imported, 1);
    assert.equal(result.newVersions, 1);
    assert.equal(await bodyCount(gl), 2);
    const again = await transfer.importFromObject(ctx, changed, workspace);

    assert.equal(again.alreadyImported, 1);
    assert.equal(await bodyCount(gl), 2);
  },
);

test(
  'an older unknown snapshot is another copy, not a downgrade',
  { skip },
  async (t) => {
    const { ctx, workspace, gl } = await setup(t);
    const newer = payload([{ id: A, name: 'New', extra: 'v2' }]);
    const older = payload([{ id: A, name: 'Old' }]);

    await transfer.importFromObject(ctx, newer, workspace);
    const result = await transfer.importFromObject(ctx, older, workspace);

    assert.equal(result.newVersions, 1);
    assert.equal(await bodyCount(gl), 2);
  },
);

/** Drop workspace list and selected ids; leave global headers and kv rows. */
async function unbindWorkspace(
  ws: TransferContext & { database: string },
): Promise<void> {
  await sql.execSqlScript({
    ...ws,
    sql: "DELETE FROM ItemTable WHERE key='composer.composerData';",
  });
}

/** Clear the global header blob so only kv leftovers remain. */
async function clearGlobalHeaders(
  gl: TransferContext & { database: string },
): Promise<void> {
  await sql.execSqlScript({
    ...gl,
    sql: `UPDATE ItemTable SET value='{"allComposers":[]}' WHERE key='composer.composerHeaders';`,
  });
}

test(
  'malformed workspace metadata is rejected before a new composer is written',
  { skip },
  async (t) => {
    const { ctx, workspace, gl, ws } = await setup(t);

    await transfer.importFromObject(ctx, payload(), workspace);
    const before = await bodyCount(gl);

    await sql.execSqlScript({
      ...ws,
      sql: "UPDATE ItemTable SET value='{broken' WHERE key='composer.composerData';",
    });

    await assert.rejects(
      () => transfer.importFromObject(ctx, payload(), workspace),
      (err: unknown) =>
        err instanceof TransferError && err.code === 'NEEDS_ATTENTION',
    );

    assert.equal(await bodyCount(gl), before);
  },
);

test(
  'an empty workspace list value is rejected before a new composer is written',
  { skip },
  async (t) => {
    const { ctx, workspace, gl, ws } = await setup(t);

    await transfer.importFromObject(ctx, payload(), workspace);

    await sql.execSqlScript({
      ...ws,
      sql: "UPDATE ItemTable SET value='' WHERE key='composer.composerData';",
    });

    const before = await bodyCount(gl);
    const prior = await storedItem(ws, 'composer.composerData');

    await assert.rejects(
      () => transfer.importFromObject(ctx, payload(), workspace),
      (err: unknown) =>
        err instanceof TransferError && err.code === 'NEEDS_ATTENTION',
    );

    assert.equal(await bodyCount(gl), before);
    assert.deepEqual(await storedItem(ws, 'composer.composerData'), prior);
    assert.equal(prior.text, '');
  },
);

test(
  'SQL NULL workspace metadata is rejected before a new composer is written',
  { skip },
  async (t) => {
    const { ctx, workspace, gl, ws } = await setup(t);

    await transfer.importFromObject(ctx, payload(), workspace);

    await sql.execSqlScript({
      ...ws,
      sql: "UPDATE ItemTable SET value=NULL WHERE key='composer.composerData';",
    });

    const before = await bodyCount(gl);

    await assert.rejects(
      () => transfer.importFromObject(ctx, payload(), workspace),
      (err: unknown) =>
        err instanceof TransferError && err.code === 'NEEDS_ATTENTION',
    );

    assert.equal(await bodyCount(gl), before);

    assert.deepEqual(await storedItem(ws, 'composer.composerData'), {
      type: 'null',
      text: null,
    });
  },
);

test(
  'a non-array allComposers value is left unchanged',
  { skip },
  async (t) => {
    const { ctx, workspace, gl, ws } = await setup(t);

    const value = JSON.stringify({
      allComposers: { unexpected: true },
      selectedComposerIds: [],
      lastFocusedComposerIds: [],
    });

    await transfer.importFromObject(ctx, payload(), workspace);

    await sql.execSqlScript({
      ...ws,
      sql: `UPDATE ItemTable SET value=${sqlText(value)} WHERE key='composer.composerData';`,
    });

    const before = await bodyCount(gl);

    await assert.rejects(
      () => transfer.importFromObject(ctx, payload(), workspace),
      (err: unknown) =>
        err instanceof TransferError && err.code === 'NEEDS_ATTENTION',
    );

    assert.equal(await bodyCount(gl), before);
    assert.equal((await storedItem(ws, 'composer.composerData')).text, value);
  },
);

test(
  'a header entry without a composer id is left unchanged',
  { skip },
  async (t) => {
    const { ctx, workspace, gl, ws } = await setup(t);

    const value = JSON.stringify({
      allComposers: [{ unexpected: true }],
    });

    await transfer.importFromObject(ctx, payload(), workspace);

    await sql.execSqlScript({
      ...ws,
      sql: `UPDATE ItemTable SET value=${sqlText(value)} WHERE key='composer.composerData';`,
    });

    const before = await bodyCount(gl);

    await assert.rejects(
      () => transfer.importFromObject(ctx, payload(), workspace),
      (err: unknown) =>
        err instanceof TransferError && err.code === 'NEEDS_ATTENTION',
    );

    assert.equal(await bodyCount(gl), before);
    assert.equal((await storedItem(ws, 'composer.composerData')).text, value);
  },
);

test(
  'a non-array selectedComposerIds value is left unchanged',
  { skip },
  async (t) => {
    const { ctx, workspace, gl, ws } = await setup(t);

    const value = JSON.stringify({
      allComposers: [],
      selectedComposerIds: { unexpected: true },
    });

    await transfer.importFromObject(ctx, payload(), workspace);

    await sql.execSqlScript({
      ...ws,
      sql: `UPDATE ItemTable SET value=${sqlText(value)} WHERE key='composer.composerData';`,
    });

    const before = await bodyCount(gl);

    await assert.rejects(
      () => transfer.importFromObject(ctx, payload(), workspace),
      (err: unknown) =>
        err instanceof TransferError && err.code === 'NEEDS_ATTENTION',
    );

    assert.equal(await bodyCount(gl), before);
    assert.equal((await storedItem(ws, 'composer.composerData')).text, value);
  },
);

test(
  'a non-array lastFocusedComposerIds value is left unchanged',
  { skip },
  async (t) => {
    const { ctx, workspace, gl, ws } = await setup(t);

    const value = JSON.stringify({
      allComposers: [],
      lastFocusedComposerIds: 1,
    });

    await transfer.importFromObject(ctx, payload(), workspace);

    await sql.execSqlScript({
      ...ws,
      sql: `UPDATE ItemTable SET value=${sqlText(value)} WHERE key='composer.composerData';`,
    });

    const before = await bodyCount(gl);

    await assert.rejects(
      () => transfer.importFromObject(ctx, payload(), workspace),
      (err: unknown) =>
        err instanceof TransferError && err.code === 'NEEDS_ATTENTION',
    );

    assert.equal(await bodyCount(gl), before);
    assert.equal((await storedItem(ws, 'composer.composerData')).text, value);
  },
);

test(
  'an empty global header value is rejected before a new composer is written',
  { skip },
  async (t) => {
    const { ctx, workspace, gl } = await setup(t);

    await transfer.importFromObject(ctx, payload(), workspace);

    await sql.execSqlScript({
      ...gl,
      sql: "UPDATE ItemTable SET value='' WHERE key='composer.composerHeaders';",
    });

    const before = await bodyCount(gl);

    await assert.rejects(
      () => transfer.importFromObject(ctx, payload(), workspace),
      (err: unknown) =>
        err instanceof TransferError && err.code === 'NEEDS_ATTENTION',
    );

    assert.equal(await bodyCount(gl), before);
    assert.equal((await storedItem(gl, 'composer.composerHeaders')).text, '');
  },
);

test(
  'a non-array global allComposers value is left unchanged',
  { skip },
  async (t) => {
    const { ctx, workspace, gl } = await setup(t);
    const value = JSON.stringify({ allComposers: { unexpected: true } });

    await transfer.importFromObject(ctx, payload(), workspace);

    await sql.execSqlScript({
      ...gl,
      sql: `UPDATE ItemTable SET value=${sqlText(value)} WHERE key='composer.composerHeaders';`,
    });

    const before = await bodyCount(gl);

    await assert.rejects(
      () => transfer.importFromObject(ctx, payload(), workspace),
      (err: unknown) =>
        err instanceof TransferError && err.code === 'NEEDS_ATTENTION',
    );

    assert.equal(await bodyCount(gl), before);

    assert.equal(
      (await storedItem(gl, 'composer.composerHeaders')).text,
      value,
    );
  },
);

test(
  'missing optional list fields stay allowed and unknown fields are kept',
  { skip },
  async (t) => {
    const { ctx, workspace, gl, ws } = await setup(t);

    await transfer.importFromObject(ctx, payload(), workspace);

    await sql.execSqlScript({
      ...ws,
      sql: `UPDATE ItemTable SET value=${sqlText('{"kept":true}')} WHERE key='composer.composerData';`,
    });

    await sql.execSqlScript({
      ...gl,
      sql: `UPDATE ItemTable SET value=${sqlText('{"kept":true}')} WHERE key='composer.composerHeaders';`,
    });

    const again = await transfer.importFromObject(ctx, payload(), workspace);

    const workspaceValue = JSON.parse(
      (await storedItem(ws, 'composer.composerData')).text || '{}',
    ) as { kept?: boolean; allComposers?: unknown[] };

    const globalValue = JSON.parse(
      (await storedItem(gl, 'composer.composerHeaders')).text || '{}',
    ) as { kept?: boolean };

    assert.equal(again.imported, 1);
    assert.equal(workspaceValue.kept, true);
    assert.ok(Array.isArray(workspaceValue.allComposers));
    assert.equal(globalValue.kept, true);
  },
);

test(
  'a malformed active body is not treated as already imported',
  { skip },
  async (t) => {
    const { ctx, workspace, gl } = await setup(t);
    const first = await transfer.importFromObject(ctx, payload(), workspace);
    const id = first.composerIds[0]!;

    await sql.execSqlScript({
      ...gl,
      sql: `UPDATE cursorDiskKV SET value='{broken' WHERE key='composerData:${id}';`,
    });

    await assert.rejects(
      () => transfer.importFromObject(ctx, payload(), workspace),
      (err: unknown) =>
        err instanceof TransferError && err.code === 'NEEDS_ATTENTION',
    );
  },
);

test(
  'a missing bubble named by the body is not treated as already imported',
  { skip },
  async (t) => {
    const { ctx, workspace, gl } = await setup(t);
    const withBubble = payload() as unknown as ExportObject;

    withBubble.composers[A] = JSON.stringify({
      _v: 18,
      composerId: A,
      name: 'Original title',
      fullConversationHeadersOnly: [{ bubbleId: X }],
    });

    withBubble.bubbles = {
      [A]: [
        {
          key: `bubbleId:${A}:${X}`,
          bubbleId: X,
          value: JSON.stringify({ bubbleId: X, type: 1, text: 'kept' }),
        },
      ],
    };

    const first = await transfer.importFromObject(ctx, withBubble, workspace);
    const id = first.composerIds[0]!;

    await sql.execSqlScript({
      ...gl,
      sql: `DELETE FROM cursorDiskKV WHERE key GLOB 'bubbleId:${id}:*';`,
    });

    await assert.rejects(
      () => transfer.importFromObject(ctx, withBubble, workspace),
      (err: unknown) =>
        err instanceof TransferError && err.code === 'NEEDS_ATTENTION',
    );
  },
);

test(
  'an isArchived SQL column keeps an intact archived copy',
  { skip },
  async (t) => {
    const { ctx, workspace, gl, ws } = await setup(t);
    const first = await transfer.importFromObject(ctx, payload(), workspace);
    const oldId = first.composerIds[0]!;

    await unbindWorkspace(ws);
    await clearGlobalHeaders(gl);

    await sql.execSqlScript({
      ...gl,
      sql: `CREATE TABLE composerHeaders(
  composerId TEXT PRIMARY KEY,
  workspaceId TEXT,
  value BLOB,
  isArchived INTEGER
);
INSERT INTO composerHeaders(composerId, workspaceId, value, isArchived)
VALUES('${oldId}','target','{"composerId":"${oldId}"}',1);`,
    });

    const again = await transfer.importFromObject(ctx, payload(), workspace);

    assert.equal(again.imported, 0);
    assert.equal(again.alreadyImported, 1);
    assert.equal(await bodyCount(gl), 1);
  },
);

test(
  'dropping grouping.textPreview does not import another copy',
  { skip },
  async (t) => {
    const { ctx, workspace, gl } = await setup(t);
    const bubbleA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
    const bubbleB = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
    const withPreview = payload() as unknown as ExportObject;

    const bubbleRows = [
      {
        key: `bubbleId:${A}:${bubbleA}`,
        bubbleId: bubbleA,
        value: JSON.stringify({ bubbleId: bubbleA, type: 1, text: 'hello' }),
      },
      {
        key: `bubbleId:${A}:${bubbleB}`,
        bubbleId: bubbleB,
        value: JSON.stringify({ bubbleId: bubbleB, type: 1, text: 'world' }),
      },
    ];

    withPreview.bubbles = { [A]: bubbleRows };

    withPreview.composers[A] = JSON.stringify({
      _v: 18,
      composerId: A,
      name: 'Original title',
      fullConversationHeadersOnly: [
        { bubbleId: bubbleA, grouping: { textPreview: 'shown in the list' } },
        { bubbleId: bubbleB, grouping: { textPreview: 'also shown' } },
      ],
    });

    const first = await transfer.importFromObject(ctx, withPreview, workspace);

    assert.equal(first.imported, 1);

    const withoutPreview = payload() as unknown as ExportObject;

    withoutPreview.bubbles = { [A]: bubbleRows };

    withoutPreview.composers[A] = JSON.stringify({
      _v: 18,
      composerId: A,
      name: 'Original title',
      fullConversationHeadersOnly: [
        { bubbleId: bubbleA },
        { bubbleId: bubbleB },
      ],
    });

    const again = await transfer.importFromObject(
      ctx,
      withoutPreview,
      workspace,
    );

    assert.equal(again.imported, 0);
    assert.equal(again.alreadyImported, 1);
    assert.equal(await bodyCount(gl), 1);
  },
);

test(
  'an intact active chat bound by the global header table is not copied',
  { skip },
  async (t) => {
    const { ctx, workspace, gl, ws } = await setup(t);
    const first = await transfer.importFromObject(ctx, payload(), workspace);
    const oldId = first.composerIds[0]!;

    await unbindWorkspace(ws);
    await clearGlobalHeaders(gl);

    await sql.execSqlScript({
      ...gl,
      sql: `CREATE TABLE composerHeaders(
  composerId TEXT PRIMARY KEY,
  workspaceId TEXT,
  value BLOB,
  isArchived INTEGER DEFAULT 0
);
INSERT INTO composerHeaders(composerId, workspaceId, value, isArchived)
VALUES(
  '${oldId}',
  'target',
  '{"composerId":"${oldId}","workspaceIdentifier":{"id":"target","uri":"file:///fixture"}}',
  0
);`,
    });

    const again = await transfer.importFromObject(ctx, payload(), workspace);

    assert.equal(again.imported, 0);
    assert.equal(again.alreadyImported, 1);
    assert.equal(await bodyCount(gl), 1);
  },
);

test(
  'a global header for another workspace does not count as this workspace',
  { skip },
  async (t) => {
    const { ctx, workspace, gl, ws } = await setup(t);
    const first = await transfer.importFromObject(ctx, payload(), workspace);
    const oldId = first.composerIds[0]!;
    const oldBody = await db.readKvText(gl, `composerData:${oldId}`);

    await unbindWorkspace(ws);
    await clearGlobalHeaders(gl);

    await sql.execSqlScript({
      ...gl,
      sql: `CREATE TABLE composerHeaders(
  composerId TEXT PRIMARY KEY,
  workspaceId TEXT,
  value BLOB
);
INSERT INTO composerHeaders(composerId, workspaceId, value)
VALUES('${oldId}','elsewhere','{"composerId":"${oldId}","workspaceIdentifier":{"id":"elsewhere"}}');`,
    });

    const again = await transfer.importFromObject(ctx, payload(), workspace);

    assert.equal(again.imported, 1);
    assert.equal(again.restored, 1);
    assert.equal(await bodyCount(gl), 2);
    assert.equal(await db.readKvText(gl, `composerData:${oldId}`), oldBody);
  },
);

test(
  'contradictory workspace ids block import without a new copy',
  { skip },
  async (t) => {
    const { ctx, workspace, gl, ws } = await setup(t);
    const first = await transfer.importFromObject(ctx, payload(), workspace);
    const oldId = first.composerIds[0]!;

    await unbindWorkspace(ws);
    await clearGlobalHeaders(gl);

    await sql.execSqlScript({
      ...gl,
      sql: `CREATE TABLE composerHeaders(
  composerId TEXT PRIMARY KEY,
  workspaceId TEXT,
  value BLOB
);
INSERT INTO composerHeaders(composerId, workspaceId, value)
VALUES('${oldId}','target','{"composerId":"${oldId}","workspaceIdentifier":{"id":"elsewhere"}}');`,
    });

    const before = await bodyCount(gl);

    await assert.rejects(
      () => transfer.importFromObject(ctx, payload(), workspace),
      (err: unknown) =>
        err instanceof TransferError && err.code === 'NEEDS_ATTENTION',
    );

    assert.equal(await bodyCount(gl), before);
  },
);

test('deleted copy can be restored after a full wipe', { skip }, async (t) => {
  const { ctx, workspace, gl, ws } = await setup(t);

  await transfer.importFromObject(ctx, payload(), workspace);

  await sql.execSqlScript({
    ...gl,
    sql: `DELETE FROM cursorDiskKV WHERE key GLOB 'composerData:*' OR key GLOB 'bubbleId:*';`,
  });

  await clearGlobalHeaders(gl);
  await unbindWorkspace(ws);
  const restored = await transfer.importFromObject(ctx, payload(), workspace);

  assert.equal(restored.imported, 1);
  assert.equal(restored.restored, 1);
  assert.equal(await bodyCount(gl), 1);
});

test(
  'leftover body without a workspace list restores a new copy',
  { skip },
  async (t) => {
    const { ctx, workspace, gl, ws } = await setup(t);
    const first = await transfer.importFromObject(ctx, payload(), workspace);
    const oldId = first.composerIds[0]!;
    const oldBody = await db.readKvText(gl, `composerData:${oldId}`);

    await unbindWorkspace(ws);
    await clearGlobalHeaders(gl);
    const restored = await transfer.importFromObject(ctx, payload(), workspace);

    assert.equal(restored.imported, 1);
    assert.equal(restored.restored, 1);
    assert.notEqual(restored.composerIds[0], oldId);
    assert.equal(await db.readKvText(gl, `composerData:${oldId}`), oldBody);
    assert.equal(await bodyCount(gl), 2);
    const again = await transfer.importFromObject(ctx, payload(), workspace);

    assert.equal(again.imported, 0);
    assert.equal(again.alreadyImported, 1);
  },
);

test(
  'leftover global header without a workspace list restores a new copy',
  { skip },
  async (t) => {
    const { ctx, workspace, gl, ws } = await setup(t);
    const first = await transfer.importFromObject(ctx, payload(), workspace);
    const oldId = first.composerIds[0]!;

    await unbindWorkspace(ws);
    const restored = await transfer.importFromObject(ctx, payload(), workspace);

    assert.equal(restored.imported, 1);
    assert.notEqual(restored.composerIds[0], oldId);
    assert.equal(await bodyCount(gl), 2);
  },
);

test(
  'archived global header without a body restores a new copy',
  { skip },
  async (t) => {
    const { ctx, workspace, gl, ws } = await setup(t);
    const first = await transfer.importFromObject(ctx, payload(), workspace);
    const oldId = first.composerIds[0]!;

    await unbindWorkspace(ws);
    await clearGlobalHeaders(gl);

    await sql.execSqlScript({
      ...gl,
      sql: `DELETE FROM cursorDiskKV WHERE key='composerData:${oldId}' OR key GLOB 'bubbleId:${oldId}:*';
CREATE TABLE composerHeaders(
  composerId TEXT PRIMARY KEY,
  workspaceId TEXT,
  value BLOB,
  isArchived INTEGER
);
INSERT INTO composerHeaders(composerId, workspaceId, value, isArchived)
VALUES('${oldId}','target','{"composerId":"${oldId}","isArchived":true}',1);`,
    });

    const restored = await transfer.importFromObject(ctx, payload(), workspace);

    assert.equal(restored.imported, 1);
    assert.notEqual(restored.composerIds[0], oldId);

    const leftover = await sql.execSql({
      ...gl,
      sql: `SELECT isArchived FROM composerHeaders WHERE composerId='${oldId}';`,
    });

    assert.equal(leftover.trim(), '1');
  },
);

test(
  'leftover bubbles without a body restore a new copy',
  { skip },
  async (t) => {
    const { ctx, workspace, gl, ws } = await setup(t);
    const withBubble = payload() as unknown as ExportObject;
    const bubbleValue = JSON.stringify({ type: 1, text: 'kept' });

    withBubble.bubbles = {
      [A]: [
        {
          key: `bubbleId:${A}:${X}`,
          bubbleId: X,
          value: bubbleValue,
        },
      ],
    };

    withBubble.composers[A] = JSON.stringify({
      _v: 18,
      composerId: A,
      name: 'Original title',
      fullConversationHeadersOnly: [{ bubbleId: X }],
    });

    const first = await transfer.importFromObject(ctx, withBubble, workspace);
    const oldId = first.composerIds[0]!;

    await unbindWorkspace(ws);
    await clearGlobalHeaders(gl);

    await sql.execSqlScript({
      ...gl,
      sql: `DELETE FROM cursorDiskKV WHERE key='composerData:${oldId}';`,
    });

    const leftoverBubbles = await sql.execSql({
      ...gl,
      sql: `SELECT count(*) FROM cursorDiskKV WHERE key GLOB 'bubbleId:${oldId}:*';`,
    });

    assert.equal(Number(leftoverBubbles.trim()), 1);

    const restored = await transfer.importFromObject(
      ctx,
      withBubble,
      workspace,
    );

    assert.equal(restored.imported, 1);
    assert.notEqual(restored.composerIds[0], oldId);

    assert.equal(
      Number(
        (
          await sql.execSql({
            ...gl,
            sql: `SELECT count(*) FROM cursorDiskKV WHERE key GLOB 'bubbleId:${oldId}:*';`,
          })
        ).trim(),
      ),
      1,
    );
  },
);

test(
  'a workspace binding without a body still needs attention',
  { skip },
  async (t) => {
    const { ctx, workspace, gl } = await setup(t);
    const first = await transfer.importFromObject(ctx, payload(), workspace);
    const id = first.composerIds[0]!;

    await sql.execSqlScript({
      ...gl,
      sql: `DELETE FROM cursorDiskKV WHERE key='composerData:${id}';`,
    });

    await assert.rejects(
      () => transfer.importFromObject(ctx, payload(), workspace),
      (err: unknown) =>
        err instanceof TransferError &&
        err.code === 'NEEDS_ATTENTION' &&
        typeof err.detail === 'string' &&
        /inconsistent-target/.test(err.detail) &&
        err.detail.includes(id),
    );
  },
);

test(
  'pending leftover body is not treated as a finished import',
  { skip },
  async (t) => {
    const { ctx, workspace, gl, ws, dir } = await setup(t);
    const first = await transfer.importFromObject(ctx, payload(), workspace);
    const oldId = first.composerIds[0]!;
    const oldBody = await db.readKvText(gl, `composerData:${oldId}`);

    assert.ok(oldBody);
    const targetKey = await targetKeyFor(workspace);
    const journalDir = path.join(dir, 'cursor-chat-transit');
    const journal = await loadJournal(journalDir, targetKey);
    const receipt = journal.receipts[0];

    assert.ok(receipt);

    await saveJournal(journalDir, {
      version: 1,
      targetKey,
      receipts: [],
      pending: {
        operationId: 'op',
        phase: 'global-written',
        chats: [
          {
            sourceComposerId: receipt.sourceComposerId,
            snapshotHash: receipt.snapshotHash,
            targetComposerId: oldId,
            bubbleMap: [],
            expectedComposerHash: sha256Text(oldBody),
            expectedBubbles: [],
            expectedResources: [],
            quality: 'complete',
          },
        ],
      },
    });

    await unbindWorkspace(ws);

    await assert.rejects(
      () => transfer.importFromObject(ctx, payload(), workspace),
      (err: unknown) =>
        err instanceof TransferError &&
        err.code === 'NEEDS_ATTENTION' &&
        typeof err.detail === 'string' &&
        /pendingTarget=/.test(err.detail),
    );

    assert.equal(await db.readKvText(gl, `composerData:${oldId}`), oldBody);
  },
);

test(
  'history-only then a complete snapshot is a new copy, not a skip',
  { skip },
  async (t) => {
    const { ctx, workspace, gl } = await setup(t);
    const digest = createHash('sha256').update('blob').digest('hex');
    const key = `agentKv:blob:${digest}`;

    const state =
      '~' +
      Buffer.concat([
        Buffer.from([10, 32]),
        Buffer.from(digest, 'hex'),
      ]).toString('base64');

    const base = {
      formatVersion: 3,
      allComposers: [{ composerId: A, name: 'With blob' }],
      composers: {
        [A]: JSON.stringify({
          _v: 18,
          composerId: A,
          conversationState: state,
          fullConversationHeadersOnly: [],
        }),
      },
      bubbles: { [A]: [] },
    };

    await transfer.importFromObject(
      ctx,
      { ...base, resources: { kv: [], attachments: [], plans: [] } },
      workspace,
      { allowPartial: true },
    );

    const complete = await transfer.importFromObject(
      ctx,
      {
        ...base,
        resources: {
          kv: [
            {
              key,
              value: dep.encodeSqliteBytes(Buffer.from('blob'), 'blob'),
            },
          ],
          attachments: [],
          plans: [],
        },
      },
      workspace,
    );

    assert.equal(complete.imported, 1);
    assert.equal(await bodyCount(gl), 2);
  },
);

test(
  'all-skip import does not write backups or sqlite rows',
  { skip },
  async (t) => {
    const { ctx, workspace, gl } = await setup(t);

    await transfer.importFromObject(ctx, payload(), workspace);
    const before = await backupCount(workspace);
    const phases: string[] = [];

    ctx.onPhase = (phase) => {
      phases.push(phase);
    };

    await transfer.importFromObject(ctx, payload(), workspace);
    assert.equal(await bodyCount(gl), 1);
    assert.equal(await backupCount(workspace), before);
    assert.equal(phases.includes('backup'), false);
    assert.equal(phases.includes('write'), false);
  },
);

test('a held target lock blocks a second importer', { skip }, async (t) => {
  const { ctx, workspace } = await setup(t);

  const lockDir = path.join(
    path.dirname(workspace.globalDbPath),
    'cursor-chat-transit-locks',
  );

  const lock = await acquireLock(lockDir, 'import-global');

  try {
    await assert.rejects(
      () => transfer.importFromObject(ctx, payload(), workspace),
      (err: unknown) => err instanceof TransferError && err.code === 'LOCKED',
    );
  } finally {
    await lock.release();
  }
});

test('unreadable journal does not mutate sqlite', { skip }, async (t) => {
  const { ctx, workspace, gl } = await setup(t);
  const targetKey = await targetKeyFor(workspace);
  const journalDir = path.join(workspace.storageRoot, 'cursor-chat-transit');

  await fs.mkdir(journalDir, { recursive: true });
  await fs.writeFile(journalPathFor(journalDir, targetKey), '{broken');

  await assert.rejects(
    () => transfer.importFromObject(ctx, payload(), workspace),
    (err: unknown) =>
      err instanceof TransferError && err.code === 'JOURNAL_INVALID',
  );

  assert.equal(await bodyCount(gl), 0);
});

test(
  'empty pending leftover is cleared instead of minting a blocked error',
  { skip },
  async (t) => {
    const { ctx, workspace, gl } = await setup(t);
    const targetKey = await targetKeyFor(workspace);
    const journalDir = path.join(workspace.storageRoot, 'cursor-chat-transit');

    await saveJournal(journalDir, {
      version: 1,
      targetKey,
      receipts: [],
      pending: {
        operationId: 'op',
        phase: 'prepared',
        chats: [
          {
            sourceComposerId: A,
            snapshotHash: 'x',
            targetComposerId: X,
            bubbleMap: [],
            expectedComposerHash: 'x',
            expectedBubbles: [],
            quality: 'complete',
          },
        ],
      },
    });

    const result = await transfer.importFromObject(ctx, payload(), workspace);

    assert.equal(result.imported, 1);
    assert.equal(await bodyCount(gl), 1);
  },
);

test('cloneExportObjectForCopy reuses a prepared composer map', async () => {
  const prepared = '99999999-9999-4999-8999-999999999999';

  const { cloned, composerMap } = await transfer.cloneExportObjectForCopy(
    payload(),
    { composerMap: new Map([[A, prepared]]) },
  );

  assert.equal(composerMap.get(A), prepared);
  assert.equal(cloned.allComposers[0]?.composerId, prepared);
});

test(
  'pending plan import after workspace commit reconciles without a duplicate',
  { skip },
  async (t) => {
    const { ctx, workspace, gl, dir } = await setup(t);

    ctx.plansDir = path.join(dir, 'plans');
    const obj: ExportObject = { ...payload(), bubbles: { [A]: [] } };

    obj.composers[A] = JSON.stringify({
      _v: 18,
      composerId: A,
      planUri: 'file:///source/.cursor/plans/demo.plan.md',
    });

    obj.resources!.plans = [encodePlan('demo.plan.md', Buffer.from('# Plan'))];

    ctx.onPhase = (phase) => {
      if (phase === 'workspace-commit')
        throw new Error('simulated interruption');
    };

    await assert.rejects(transfer.importFromObject(ctx, obj, workspace));
    delete ctx.onPhase;
    const retry = await transfer.importFromObject(ctx, obj, workspace);

    assert.equal(retry.alreadyImported, 1);
    assert.equal(await bodyCount(gl), 1);
  },
);

test(
  'pending retry fails closed if a recorded plan file was changed',
  { skip },
  async (t) => {
    const { ctx, workspace, gl, dir } = await setup(t);

    ctx.plansDir = path.join(dir, 'plans');
    const obj: ExportObject = { ...payload(), bubbles: { [A]: [] } };

    obj.composers[A] = JSON.stringify({
      _v: 18,
      composerId: A,
      planUri: 'file:///source/.cursor/plans/demo.plan.md',
    });

    obj.resources!.plans = [encodePlan('demo.plan.md', Buffer.from('# Plan'))];

    ctx.onPhase = (phase) => {
      if (phase === 'workspace-commit')
        throw new Error('simulated interruption');
    };

    await assert.rejects(transfer.importFromObject(ctx, obj, workspace));
    delete ctx.onPhase;
    await fs.writeFile(path.join(ctx.plansDir, 'demo.plan.md'), '# Tampered\n');

    await assert.rejects(
      () => transfer.importFromObject(ctx, obj, workspace),
      (err: unknown) =>
        err instanceof TransferError && err.code === 'NEEDS_ATTENTION',
    );

    assert.equal(await bodyCount(gl), 1);
  },
);

test(
  'legacy pending without resource descriptors is not auto-verified',
  { skip },
  async (t) => {
    const { ctx, workspace, gl } = await setup(t);

    ctx.onPhase = (phase) => {
      if (phase === 'workspace-commit')
        throw new Error('simulated interruption');
    };

    await assert.rejects(transfer.importFromObject(ctx, payload(), workspace));
    delete ctx.onPhase;
    const journalDir = path.join(workspace.storageRoot, 'cursor-chat-transit');
    const targetKey = await targetKeyFor(workspace);
    const journal = await loadJournal(journalDir, targetKey);

    assert.ok(journal.pending);
    for (const chat of journal.pending.chats) delete chat.expectedResources;
    await saveJournal(journalDir, journal);

    await assert.rejects(
      () => transfer.importFromObject(ctx, payload(), workspace),
      (err: unknown) =>
        err instanceof TransferError && err.code === 'NEEDS_ATTENTION',
    );

    assert.equal(await bodyCount(gl), 1);
  },
);

test(
  'global-only pending import is not promoted to a verified receipt',
  { skip },
  async (t) => {
    const { ctx, workspace, gl, ws } = await setup(t);

    ctx.onPhase = (phase) => {
      if (phase === 'global-commit') throw new Error('simulated interruption');
    };

    await assert.rejects(transfer.importFromObject(ctx, payload(), workspace));
    delete ctx.onPhase;
    assert.equal(await db.readItemText(ws, 'composer.composerData'), null);

    await assert.rejects(
      transfer.importFromObject(ctx, payload(), workspace),
      (err: unknown) =>
        err instanceof TransferError && err.code === 'NEEDS_ATTENTION',
    );

    assert.equal(await bodyCount(gl), 1);
  },
);

test(
  'successful import and repeat use journals without database backup files',
  { skip },
  async (t) => {
    const { ctx, workspace, gl } = await setup(t);
    const journalDir = path.join(workspace.storageRoot, 'no-backup-journal');
    const phases: string[] = [];

    const first = await transfer.importFromObject(
      {
        ...ctx,
        onPhase: (phase) => {
          phases.push(phase);
        },
      },
      payload(),
      workspace,
      { journalDir },
    );

    assert.equal(first.imported, 1);
    assert.equal(await bodyCount(gl), 1);
    assert.equal(phases.includes('backup'), false);
    const names = await fs.readdir(journalDir);

    assert.ok(names.some((name) => name.endsWith('.sqlite')));

    assert.equal(
      names.some(
        (name) => name.includes('.backup-') || name.endsWith('.vscdb'),
      ),
      false,
    );

    assert.equal(await backupCount(workspace), 0);

    const second = await transfer.importFromObject(ctx, payload(), workspace, {
      journalDir,
    });

    assert.equal(second.imported, 0);
    assert.equal(second.alreadyImported, 1);
  },
);

function familyPayload(extra = '') {
  const result = payload([
    { id: A, name: 'Parent' },
    { id: B, name: 'Child', extra },
  ]);

  (
    result.allComposers[0] as { subagentComposerIds?: string[] }
  ).subagentComposerIds = [B];

  Object.assign(result.allComposers[1], {
    isSubagent: true,
    subagentInfo: { parentComposerId: A, rootParentConversationId: A },
  });

  result.composers[A] = JSON.stringify({
    ...JSON.parse(result.composers[A]),
    subagentComposerIds: [B],
  });

  result.composers[B] = JSON.stringify({
    ...JSON.parse(result.composers[B]),
    subagentInfo: { parentComposerId: A, rootParentConversationId: A },
  });

  return result;
}

/** New Cursor state fixture with embedded composer and bubble UUID strings. */
function stateFamilyPayload() {
  const result = familyPayload() as unknown as ExportObject;
  const bubble = X;

  const stateBytes = Buffer.concat(
    [A, B, bubble].map((id) =>
      Buffer.concat([
        Buffer.from([0xa2, 0x06, Buffer.byteLength(id)]),
        Buffer.from(id),
      ]),
    ),
  );

  const state = `~${stateBytes.toString('base64')}`;
  const parent = JSON.parse(result.composers[A]) as Record<string, unknown>;

  parent.conversationState = state;
  result.composers[A] = JSON.stringify(parent);

  result.bubbles![A] = [
    {
      key: `bubbleId:${A}:${bubble}`,
      bubbleId: bubble,
      value: JSON.stringify({
        _v: 3,
        composerId: A,
        bubbleId: bubble,
        type: 1,
        text: 'state-backed message',
      }),
    },
  ];

  return result;
}

test(
  'new Cursor state remaps parent, child, and bubble ids together',
  { skip },
  async (t) => {
    const { ctx, workspace, gl } = await setup(t);

    const result = await transfer.importFromObject(
      ctx,
      stateFamilyPayload(),
      workspace,
    );

    const parent = result.composerIds[0]!;
    const child = result.composerIds[1]!;

    const body = JSON.parse(
      (await db.readKvText(gl, `composerData:${parent}`)) || '{}',
    ) as { conversationState: string };

    const state = Buffer.from(
      body.conversationState.slice(1),
      'base64',
    ).toString('utf8');

    const bubbleKey = (
      await sql.execSql({
        ...gl,
        sql: `SELECT key FROM cursorDiskKV WHERE key >= ${sqlText(`bubbleId:${parent}:`)} AND key < ${sqlText(`bubbleId:${parent};`)} LIMIT 1;`,
      })
    ).trim();

    const bubble = bubbleKey.slice(`bubbleId:${parent}:`.length);

    const childBody = JSON.parse(
      (await db.readKvText(gl, `composerData:${child}`)) || '{}',
    ) as { subagentInfo?: { parentComposerId?: string } };

    assert.equal(state.includes(parent), true);
    assert.equal(state.includes(child), true);
    assert.equal(state.includes(bubble), true);
    assert.equal(state.includes(A), false);
    assert.equal(state.includes(B), false);
    assert.equal(state.includes(X), false);
    assert.equal(childBody.subagentInfo?.parentComposerId, parent);

    const catalogs = await Promise.all(
      [
        [gl, 'composer.composerHeaders'],
        [
          { ...ctx, database: workspace.workspaceDbPath },
          'composer.composerData',
        ],
      ].map(async ([conn, key]) =>
        JSON.parse(
          (await db.readItemText(
            conn as TransferContext & { database: string },
            key as string,
          )) || '{}',
        ),
      ),
    );

    for (const catalog of catalogs) {
      const headers = catalog.allComposers as Array<{
        composerId: string;
        subagentComposerIds?: string[];
        subagentInfo?: { parentComposerId?: string };
      }>;

      const parentHeader = headers.find(
        (header) => header.composerId === parent,
      );

      const childHeader = headers.find((header) => header.composerId === child);

      assert.deepEqual(parentHeader?.subagentComposerIds, [child]);
      assert.equal(childHeader?.subagentInfo?.parentComposerId, parent);
    }
  },
);

test(
  'a changed family is not copied again on the next identical import',
  { skip },
  async (t) => {
    const { ctx, workspace, gl } = await setup(t);

    const opts = {
      journalDir: path.join(path.dirname(gl.database), 'journal'),
    };

    await transfer.importFromObject(ctx, familyPayload('v1'), workspace, opts);
    await transfer.importFromObject(ctx, familyPayload('v2'), workspace, opts);
    assert.equal(await bodyCount(gl), 4);

    const third = await transfer.importFromObject(
      ctx,
      familyPayload('v2'),
      workspace,
      opts,
    );

    assert.equal(await bodyCount(gl), 4, JSON.stringify(third));
  },
);

test(
  'each family version reuses one coherent destination mapping',
  { skip },
  async (t) => {
    const { ctx, workspace, gl } = await setup(t);

    const opts = {
      journalDir: path.join(path.dirname(gl.database), 'journal'),
    };

    await transfer.importFromObject(ctx, familyPayload('v1'), workspace, opts);
    await transfer.importFromObject(ctx, familyPayload('v2'), workspace, opts);

    for (const version of ['v1', 'v2']) {
      const result = await transfer.importFromObject(
        ctx,
        familyPayload(version),
        workspace,
        opts,
      );

      const parent = result.alreadyImportedChats.find(
        (row) => row.composerId === A,
      );

      const child = result.alreadyImportedChats.find(
        (row) => row.composerId === B,
      );

      assert.ok(parent?.targetComposerId);
      assert.ok(child?.targetComposerId);

      const body = JSON.parse(
        (
          await sql.execSql({
            ...gl,
            sql: `SELECT value FROM cursorDiskKV WHERE key=${sqlText(`composerData:${child.targetComposerId}`)};`,
          })
        ).trim(),
      ) as { subagentInfo: { parentComposerId: string } };

      assert.equal(
        body.subagentInfo.parentComposerId,
        parent.targetComposerId,
        version,
      );
    }
  },
);
