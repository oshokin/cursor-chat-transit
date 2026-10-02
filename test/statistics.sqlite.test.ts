import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  ensureInitFile,
  execSqlScript,
  findSqliteExecutable,
} from '../src/sqlite';
import { sqlText } from '../src/core';
import {
  runStatistics,
  type StatisticsJob,
  type StatisticsUpdate,
} from '../src/statistics';
import { runTransfer } from '../src/transfer-process';
import { observeTransfer, type TransferEvent } from '../src/transfer-events';
import type { WorkspaceEntry } from '../src/types';

const executable = findSqliteExecutable(process.env.SQLITE3_PATH)!;
const skip = !executable;

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cct-statistics-'));

  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const ctx = {
    executable,
    initFile: await ensureInitFile(root),
    timeoutMs: 10000,
  };

  const workspace: WorkspaceEntry = {
    storageRoot: root,
    storageId: 'fixture',
    globalDbPath: path.join(root, 'global.vscdb'),
    workspaceDbPath: path.join(root, 'workspace.vscdb'),
    key: 'fixture',
    mtime: 0,
  };

  const headers = [
    { composerId: 'legacy', name: 'Legacy' },
    { composerId: 'empty' },
    { composerId: 'agent', name: 'Agent' },
  ];

  // Structural facts from the supplied minos export, with no private text or IDs.
  const bodies = [
    {
      _v: 17,
      isNAL: false,
      conversationState: '~',
      fullConversationHeadersOnly: [
        ...Array.from({ length: 3 }, () => ({ type: 1 })),
        ...Array.from({ length: 40 }, () => ({ type: 2 })),
      ],
    },
    { _v: 10, isNAL: false, fullConversationHeadersOnly: [] },
    {
      _v: 17,
      isNAL: true,
      fullConversationHeadersOnly: [
        { type: 1 },
        { type: 1 },
        ...Array.from({ length: 131 }, () => ({ type: 2 })),
      ],
    },
  ];

  await execSqlScript({
    ...ctx,
    database: workspace.globalDbPath,
    sql: `CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY,value BLOB); CREATE TABLE ItemTable(key TEXT PRIMARY KEY,value BLOB); ${headers.map((h, i) => `INSERT INTO cursorDiskKV VALUES (${sqlText(`composerData:${h.composerId}`)},${sqlText(JSON.stringify(bodies[i]))});`).join('\n')} INSERT INTO cursorDiskKV VALUES ('agentKv:blob:unrelated',zeroblob(8388608));`,
  });

  await execSqlScript({
    ...ctx,
    database: workspace.workspaceDbPath,
    sql: `CREATE TABLE ItemTable(key TEXT PRIMARY KEY,value BLOB); INSERT INTO ItemTable VALUES('composer.composerData',${sqlText(JSON.stringify({ allComposers: headers }))});`,
  });

  return { root, ctx, workspace, headers };
}

test(
  'worker analyzes supplied format patterns, excludes unrelated data, and never writes databases',
  { skip },
  async (t) => {
    const { ctx, workspace, headers } = await fixture(t);

    const hash = async (file: string) =>
      createHash('sha256')
        .update(await fs.readFile(file))
        .digest('hex');

    const before = await hash(workspace.globalDbPath);
    const rows: StatisticsUpdate[] = [];

    const result = await runTransfer<{ failed: number }>(
      {
        ...ctx,
        kind: 'chat-statistics',
        workspace,
        chats: [...headers, { composerId: 'missing' }],
      },
      { onStatistics: (row) => rows.push(row) },
    );

    assert.equal(result.failed, 1);
    assert.match(rows[0].detail, /^3 user messages · Legacy/);
    assert.match(rows[1].detail, /^0 user messages · Legacy/);
    assert.match(rows[2].detail, /^2 user messages · Agent/);
    assert.equal(rows[3].failed, true);
    assert.equal(await hash(workspace.globalDbPath), before);
    assert.equal(JSON.stringify(rows).includes('conversationState'), false);
  },
);

test(
  'workspace scan reuses global metadata, reports corrupt metadata instead of zero, and continues',
  { skip },
  async (t) => {
    const { ctx, workspace } = await fixture(t);

    const bad = {
      ...workspace,
      storageId: 'bad',
      workspaceDbPath: path.join(workspace.storageRoot, 'bad.vscdb'),
    };

    await execSqlScript({
      ...ctx,
      database: bad.workspaceDbPath,
      sql: `CREATE TABLE ItemTable(key TEXT PRIMARY KEY,value BLOB); INSERT INTO ItemTable VALUES('composer.composerData','{broken');`,
    });

    const rows: StatisticsUpdate[] = [];
    const events: TransferEvent[] = [];

    const job: StatisticsJob = {
      ...ctx,
      kind: 'workspace-statistics',
      workspaces: [bad, workspace],
    };

    const result = await observeTransfer({ event: (e) => events.push(e) }, () =>
      runStatistics(job, new AbortController().signal, (r) => rows.push(r)),
    );

    assert.equal(result.failed, 1);
    assert.equal(rows[0].failed, true);
    assert.equal(rows[1].detail, '2 titled · 1 untitled');

    assert.equal(
      events.filter(
        (e) =>
          e.action === 'Read global chat headers' && e.status === 'started',
      ).length,
      1,
    );
  },
);

test(
  'cancellation stops before the next chat and releases the read transaction',
  { skip },
  async (t) => {
    const { ctx, workspace, headers } = await fixture(t);
    const abort = new AbortController();
    const rows: StatisticsUpdate[] = [];

    await assert.rejects(
      runStatistics(
        { ...ctx, kind: 'chat-statistics', workspace, chats: headers },
        abort.signal,
        (r) => {
          rows.push(r);
          abort.abort();
        },
      ),
      /abort/i,
    );

    assert.equal(rows.length, 1);

    await execSqlScript({
      ...ctx,
      database: workspace.globalDbPath,
      sql: 'BEGIN EXCLUSIVE; COMMIT;',
    });
  },
);
