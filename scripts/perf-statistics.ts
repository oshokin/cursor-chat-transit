import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { WorkspaceEntry } from '../src/types';
import type { StatisticsUpdate } from '../src/statistics';

/** Synthetic statistics benchmark scenario and operation policy. */
const defaultBlobCount = 2_048;
const maximumBlobCount = 10_000;
const defaultChatCount = 4;
const maximumChatCount = 100;
const benchmarkOperationTimeoutMs = 120_000;
const benchmarkRepetitions = 3;

/** Opt-in synthetic benchmark. Only temporary databases are created or opened. */
async function main(): Promise<void> {
  const project =
    process.env.CCT_BENCH_PROJECT || path.resolve(__dirname, '..');

  const { runStatistics } = require(
    path.join(project, 'out/statistics.js'),
  ) as typeof import('../src/statistics');

  const { observeTransfer } = require(
    path.join(project, 'out/transfer-events.js'),
  ) as typeof import('../src/transfer-events');

  const { execSqlScript } = require(
    path.join(project, 'out/sqlite.js'),
  ) as typeof import('../src/sqlite');

  const count = Number(process.env.CCT_BENCH_BLOBS || defaultBlobCount);
  const chatCount = Number(process.env.CCT_BENCH_CHATS || defaultChatCount);

  if (
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > maximumBlobCount ||
    !Number.isSafeInteger(chatCount) ||
    chatCount < 1 ||
    chatCount > maximumChatCount
  )
    throw new Error('Use 1–10000 blobs and 1–100 chats.');

  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'cct-statistics-bench-'),
  );

  const { sqlText } = require(
    path.join(project, 'out/core.js'),
  ) as typeof import('../src/core');

  const ctx = {
    timeoutMs: benchmarkOperationTimeoutMs,
  };

  const workspace: WorkspaceEntry = {
    storageRoot: root,
    storageId: 'bench',
    key: 'bench',
    mtime: 0,
    workspaceDbPath: path.join(root, 'workspace.vscdb'),
    globalDbPath: path.join(root, 'global.vscdb'),
  };

  try {
    const blobs = Array.from({ length: count }, (_, i) => {
      const bytes = Buffer.from(`resource-${i}:` + 'x'.repeat(2048));

      return { bytes, id: createHash('sha256').update(bytes).digest('hex') };
    });

    const state =
      '~' +
      Buffer.concat(
        blobs.map(({ id }) =>
          Buffer.concat([Buffer.from([10, 32]), Buffer.from(id, 'hex')]),
        ),
      ).toString('base64');

    const headers = Array.from({ length: chatCount }, (_, i) => ({
      composerId: `11111111-1111-4111-8111-${String(i).padStart(12, '0')}`,
      name: `Benchmark chat ${i}`,
    }));

    await execSqlScript({
      ...ctx,
      database: workspace.globalDbPath,
      sql: `CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY,value BLOB); CREATE TABLE ItemTable(key TEXT PRIMARY KEY,value BLOB); BEGIN; ${blobs.map(({ id, bytes }) => `INSERT INTO cursorDiskKV VALUES ('agentKv:blob:${id}',X'${bytes.toString('hex')}');`).join('\n')} ${headers.map(({ composerId }) => `INSERT INTO cursorDiskKV VALUES ('composerData:${composerId}',${sqlText(JSON.stringify({ _v: 17, isNAL: true, conversationState: state, fullConversationHeadersOnly: [{ bubbleId: 'message', type: 1 }] }))}); INSERT INTO cursorDiskKV VALUES ('bubbleId:${composerId}:message','{"type":1,"text":"Synthetic benchmark"}');`).join('\n')} COMMIT;`,
    });

    await execSqlScript({
      ...ctx,
      database: workspace.workspaceDbPath,
      sql: `CREATE TABLE ItemTable(key TEXT PRIMARY KEY,value BLOB); INSERT INTO ItemTable VALUES('composer.composerData',${sqlText(JSON.stringify({ allComposers: headers }))});`,
    });

    for (const kind of ['workspace-statistics', 'chat-statistics'] as const) {
      for (
        let repetition = 0;
        repetition < benchmarkRepetitions;
        repetition++
      ) {
        let events = 0,
          dependencyEvents = 0;

        const rows: StatisticsUpdate[] = [];
        const started = performance.now();

        const result = await observeTransfer(
          {
            event: (event) => {
              events++;
              if (event.action.includes('dependency')) dependencyEvents++;
            },
          },
          () =>
            runStatistics(
              {
                ...ctx,
                deepCheck: true,
                ...(kind === 'workspace-statistics'
                  ? { kind, workspaces: [workspace] }
                  : { kind, workspace, chats: headers }),
              },
              new AbortController().signal,
              (row) => rows.push(row),
            ),
        );

        if (
          result.failed ||
          (kind === 'workspace-statistics'
            ? rows[0].hide !== false
            : rows.some((row) => row.eligible !== true))
        )
          throw new Error('Benchmark result changed.');

        process.stdout.write(
          JSON.stringify({
            kind,
            repetition,
            blobs: count,
            chats: chatCount,
            elapsedMs: Math.round(performance.now() - started),
            events,
            dependencyEvents,
          }) + '\n',
        );
      }
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
