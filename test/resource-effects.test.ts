import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { historicalResourceId } from '../src/historical-artifacts';
import { planResourceEffects } from '../src/import-bundle-resources';
import { JournalStore } from '../src/journal-db';
import { SqliteSession } from '../src/sqlite-session';
import { sqlText } from '../src/core';
import type { TransferContext, WorkspaceEntry } from '../src/types';

async function workDb(file: string, rows: string): Promise<SqliteSession> {
  const work = await SqliteSession.open({ database: file });

  await work.exec(`
    CREATE TABLE chat(
      ordinal INTEGER PRIMARY KEY,
      source_id TEXT NOT NULL,
      target_id TEXT NOT NULL
    );
    CREATE TABLE res(
      ordinal INTEGER NOT NULL,
      class TEXT NOT NULL,
      id TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      filename TEXT,
      extension TEXT
    );
    ${rows}`);

  return work;
}

test('shared visualization filenames keep separate destination intents', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cct-effects-'));
  const previous = process.env.CURSOR_AGENT_STORE_DIR;

  process.env.CURSOR_AGENT_STORE_DIR = path.join(root, 'stores');

  t.after(async () => {
    if (previous === undefined) delete process.env.CURSOR_AGENT_STORE_DIR;
    else process.env.CURSOR_AGENT_STORE_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  });

  const workspace = {
    workspaceDbPath: path.join(root, 'workspace.vscdb'),
  } as WorkspaceEntry;

  const shaA = 'a'.repeat(64);
  const shaB = 'b'.repeat(64);

  const work = await workDb(
    path.join(root, 'index.sqlite'),
    `INSERT INTO chat VALUES
      (1,'source-a','composer-a'),
      (2,'source-b','composer-b');
     INSERT INTO res VALUES
      (1,'visualization','viz-a',${sqlText(shaA)},'chart.html',''),
      (2,'visualization','viz-b',${sqlText(shaB)},'chart.html','');`,
  );

  const journal = await JournalStore.open({
    journalDir: root,
    targetKey: 'workspace',
  });

  t.after(async () => {
    await work.close();
    await journal.close();
  });

  await journal.beginPending({ operationId: 'op', phase: 'prepared' });

  const plan = {
    work,
    journal,
    operationId: 'op',
    ctx: {} as TransferContext,
    workspace,
    plansDir: path.join(root, 'plans'),
    canvasesDir: null,
  };

  await planResourceEffects({ ...plan, ordinal: 1 });
  await planResourceEffects({ ...plan, ordinal: 2 });

  const effects: string[] = [];

  await journal.forEachEffect('op', (effect) => {
    effects.push(effect.target);
  });

  assert.equal(effects.length, 2);
  assert.notEqual(effects[0], effects[1]);
  assert.equal(path.basename(effects[0]!), 'chart.html');
  assert.equal(path.basename(effects[1]!), 'chart.html');
});

test('same destination with different bytes remains a hard conflict', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cct-effect-conflict-'));

  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const workspace = {
    workspaceDbPath: path.join(root, 'workspace.vscdb'),
  } as WorkspaceEntry;

  const work = await workDb(
    path.join(root, 'index.sqlite'),
    `INSERT INTO chat VALUES(1,'source','composer');
     INSERT INTO res VALUES
      (1,'plan','one',${sqlText('a'.repeat(64))},'same.md',''),
      (1,'plan','two',${sqlText('b'.repeat(64))},'same.md','');`,
  );

  const journal = await JournalStore.open({
    journalDir: root,
    targetKey: 'workspace',
  });

  t.after(async () => {
    await work.close();
    await journal.close();
  });

  await journal.beginPending({ operationId: 'op', phase: 'prepared' });

  await assert.rejects(
    planResourceEffects({
      ordinal: 1,
      work,
      journal,
      operationId: 'op',
      ctx: {} as TransferContext,
      workspace,
      plansDir: path.join(root, 'plans'),
      canvasesDir: null,
    }),
    /different destination intent/,
  );
});

test('transcript layouts with the same basename stay distinct', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cct-effect-layout-'));

  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const owner = '11111111-1111-4111-8111-111111111111';

  const canonical = historicalResourceId({
    layout: 'canonical',
    extension: 'jsonl',
  });

  const legacy = historicalResourceId({ layout: 'legacy', extension: 'jsonl' });

  const workspace = {
    workspaceDbPath: path.join(root, 'workspace.vscdb'),
    key: 'workspace-key',
  } as WorkspaceEntry;

  const work = await workDb(
    path.join(root, 'index.sqlite'),
    `INSERT INTO chat VALUES(1,'source',${sqlText(owner)});
     INSERT INTO res VALUES
      (1,'transcript',${sqlText(canonical)},${sqlText('a'.repeat(64))},'same.jsonl',''),
      (1,'transcript',${sqlText(legacy)},${sqlText('b'.repeat(64))},'same.jsonl','');`,
  );

  const journal = await JournalStore.open({
    journalDir: root,
    targetKey: 'workspace',
  });

  t.after(async () => {
    await work.close();
    await journal.close();
  });

  await journal.beginPending({ operationId: 'op', phase: 'prepared' });

  await planResourceEffects({
    ordinal: 1,
    work,
    journal,
    operationId: 'op',
    ctx: { projectArtifactsDir: path.join(root, 'project') } as TransferContext,
    workspace,
    plansDir: path.join(root, 'plans'),
    canvasesDir: null,
  });

  const effects: string[] = [];

  await journal.forEachEffect('op', (effect) => {
    effects.push(effect.target);
  });

  assert.equal(effects.length, 2);
  assert.ok(effects.some((item) => item.endsWith(`${owner}/${owner}.jsonl`)));
  assert.ok(effects.some((item) => item.endsWith(`${owner}.jsonl`)));
});
