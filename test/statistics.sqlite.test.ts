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

/** Stable UUIDs exercise the same key-range validation as real Cursor chats. */
function healthId(name: string): string {
  const hex = createHash('sha256').update(name).digest('hex').slice(0, 32);

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

test(
  'deep checks distinguish complete legacy history, empty chats, missing messages and lost bodies',
  { skip },
  async (t) => {
    const { ctx, workspace } = await fixture(t);

    const bodies: Record<string, unknown> = {
      [healthId('good')]: {
        _v: 17,
        isNAL: false,
        conversationState: '~',
        fullConversationHeadersOnly: [{ bubbleId: 'msg', type: 1 }],
      },
      [healthId('empty')]: {
        _v: 10,
        isNAL: false,
        fullConversationHeadersOnly: [],
      },
      [healthId('broken')]: {
        fullConversationHeadersOnly: [{ bubbleId: 'lost', type: 1 }],
      },
      [healthId('orphan')]: { fullConversationHeadersOnly: [] },
    };

    await execSqlScript({
      ...ctx,
      database: workspace.globalDbPath,
      sql: `DELETE FROM cursorDiskKV; ${Object.entries(bodies)
        .map(
          ([id, body]) =>
            `INSERT INTO cursorDiskKV VALUES(${sqlText('composerData:' + id)},${sqlText(JSON.stringify(body))});`,
        )
        .join(
          '\n',
        )} INSERT INTO cursorDiskKV VALUES('bubbleId:${healthId('good')}:msg','{"bubbleId":"msg","type":1,"text":"Hello"}'); INSERT INTO cursorDiskKV VALUES('bubbleId:${healthId('orphan')}:msg','{"type":1,"text":"Keep history"}');`,
    });

    const before = await fs.readFile(workspace.globalDbPath);
    const rows: StatisticsUpdate[] = [];

    await runTransfer(
      {
        ...ctx,
        kind: 'chat-statistics',
        deepCheck: true,
        workspace,
        chats: Object.keys(bodies).map((composerId) => ({ composerId })),
      },
      { onStatistics: (r) => rows.push(r) },
    );

    assert.equal(rows[0].eligible, true);
    assert.match(rows[0].detail, /Legacy format/);
    assert.equal(rows[1].eligible, false);
    assert.equal(rows[2].eligible, false);
    assert.match(rows[2].detail, /Incomplete/);
    assert.equal(rows[3].eligible, false);
    assert.match(rows[3].detail, /unknown/);
    assert.deepEqual(await fs.readFile(workspace.globalDbPath), before);

    assert.equal(
      (await fs.readdir(workspace.storageRoot)).some((n) =>
        /zip|staging|export/.test(n),
      ),
      false,
    );
  },
);

test(
  'workspace cleanup keeps legacy, incomplete and unknown history; hides only empty or absent data',
  { skip },
  async (t) => {
    const { ctx, workspace } = await fixture(t);

    await execSqlScript({
      ...ctx,
      database: workspace.globalDbPath,
      sql: `DELETE FROM cursorDiskKV; INSERT INTO cursorDiskKV VALUES('composerData:${healthId('empty')}','{"fullConversationHeadersOnly":[]}'); INSERT INTO cursorDiskKV VALUES('composerData:${healthId('broken')}','{"fullConversationHeadersOnly":[{"bubbleId":"lost","type":1}]}');`,
    });

    const workspaces: WorkspaceEntry[] = [];

    for (const id of ['empty', 'missing', 'broken']) {
      const entry = {
        ...workspace,
        storageId: id,
        workspaceDbPath: path.join(workspace.storageRoot, id + '.vscdb'),
      };

      await execSqlScript({
        ...ctx,
        database: entry.workspaceDbPath,
        sql: `CREATE TABLE ItemTable(key TEXT PRIMARY KEY,value BLOB); INSERT INTO ItemTable VALUES('composer.composerData',${sqlText(JSON.stringify({ allComposers: [{ composerId: healthId(id) }] }))});`,
      });

      workspaces.push(entry);
    }

    const rows: StatisticsUpdate[] = [];

    await runStatistics(
      { ...ctx, kind: 'workspace-statistics', deepCheck: true, workspaces },
      new AbortController().signal,
      (r) => rows.push(r),
    );

    assert.deepEqual(
      rows.map((r) => r.hide),
      [true, true, false],
    );
  },
);

test(
  'deep selection excludes a chat with a missing image and rejects unknown state without hiding history',
  { skip },
  async (t) => {
    const { ctx, workspace } = await fixture(t);
    const imageId = healthId('image');
    const unknownId = healthId('future');

    const body = {
      _v: 17,
      fullConversationHeadersOnly: [{ bubbleId: 'm', type: 1 }],
      conversationState: '~',
    };

    await execSqlScript({
      ...ctx,
      database: workspace.globalDbPath,
      sql: `DELETE FROM cursorDiskKV;
  INSERT INTO cursorDiskKV VALUES(${sqlText('composerData:' + imageId)},${sqlText(JSON.stringify(body))});
  INSERT INTO cursorDiskKV VALUES(${sqlText('bubbleId:' + imageId + ':m')},${sqlText(JSON.stringify({ type: 1, images: [{ uuid: healthId('missing-image') }] }))});
  INSERT INTO cursorDiskKV VALUES(${sqlText('composerData:' + unknownId)},${sqlText(JSON.stringify({ ...body, _v: 99 }))});
  INSERT INTO cursorDiskKV VALUES(${sqlText('bubbleId:' + unknownId + ':m')},'{"type":1}');`,
    });

    const rows: StatisticsUpdate[] = [];

    await runStatistics(
      {
        ...ctx,
        kind: 'chat-statistics',
        deepCheck: true,
        workspace,
        chats: [{ composerId: imageId }, { composerId: unknownId }],
      },
      new AbortController().signal,
      (r) => rows.push(r),
    );

    assert.equal(rows[0].eligible, false);
    assert.match(rows[0].detail, /Incomplete/);
    assert.equal(rows[1].failed, true);
    assert.notEqual(rows[1].eligible, true);
  },
);

test(
  'a referenced canvas without a workspace canvas directory is incomplete',
  { skip },
  async (t) => {
    const { ctx, workspace } = await fixture(t);
    const id = healthId('canvas');

    const body = {
      fullConversationHeadersOnly: [{ bubbleId: 'm', type: 1 }],
      canvas: { path: '/source/canvases/chart.canvas.tsx' },
    };

    await execSqlScript({
      ...ctx,
      database: workspace.globalDbPath,
      sql: `INSERT INTO cursorDiskKV VALUES(${sqlText('composerData:' + id)},${sqlText(JSON.stringify(body))}); INSERT INTO cursorDiskKV VALUES(${sqlText('bubbleId:' + id + ':m')},'{"type":1}');`,
    });

    const rows: StatisticsUpdate[] = [];

    await runStatistics(
      {
        ...ctx,
        kind: 'chat-statistics',
        deepCheck: true,
        workspace,
        chats: [{ composerId: id }],
      },
      new AbortController().signal,
      (r) => rows.push(r),
    );

    assert.equal(rows[0].eligible, false);
    assert.match(rows[0].detail, /Incomplete/);
  },
);
