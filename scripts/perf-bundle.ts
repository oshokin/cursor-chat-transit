import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { TransferContext, WorkspaceEntry } from '../src/types';

/** Opt-in repeatable benchmark; only temporary databases are opened. Compile first. */
async function main(): Promise<void> {
  const project =
    process.env.CCT_BENCH_PROJECT || path.resolve(__dirname, '..');

  const { BundleWriter } = require(
    path.join(project, 'out/bundle-writer.js'),
  ) as typeof import('../src/bundle-writer');

  const { importFromBundle } = require(
    path.join(project, 'out/import-bundle.js'),
  ) as typeof import('../src/import-bundle');

  const { exportToFile } = require(
    path.join(project, 'out/export-transfer.js'),
  ) as typeof import('../src/export-transfer');

  const sql = require(
    path.join(project, 'out/sqlite.js'),
  ) as typeof import('../src/sqlite');

  const count = Number(process.env.CCT_BENCH_MESSAGES || 3000);
  const payloadBytes = Number(process.env.CCT_BENCH_MESSAGE_BYTES || 16384);

  if (
    !Number.isSafeInteger(count) ||
    count < 1 ||
    !Number.isSafeInteger(payloadBytes) ||
    payloadBytes < 1
  )
    throw new Error('Invalid benchmark size.');
  const executable = sql.findSqliteExecutable(process.env.SQLITE3_PATH);

  if (!executable) throw new Error('sqlite3 is required.');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cct-bench-'));
  const chat = '11111111-1111-4111-8111-111111111111';
  let rss = process.memoryUsage().rss;

  const sample = setInterval(() => {
    rss = Math.max(rss, process.memoryUsage().rss);
  }, 25);

  try {
    const ctx: TransferContext = {
      executable,
      initFile: await sql.ensureInitFile(root),
    };

    const workspace: WorkspaceEntry = {
      storageRoot: root,
      storageId: 'benchmark',
      key: 'benchmark',
      mtime: 0,
      identity: {
        kind: 'folder',
        uri: { scheme: 'file', authority: '', path: '/benchmark' },
      },
      globalDbPath: path.join(root, 'global.sqlite'),
      workspaceDbPath: path.join(root, 'workspace.sqlite'),
    };

    await sql.execSqlScript({
      ...ctx,
      database: workspace.globalDbPath,
      sql: `PRAGMA journal_mode=WAL; CREATE TABLE ItemTable(key TEXT PRIMARY KEY,value BLOB); CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY,value BLOB); INSERT INTO ItemTable VALUES('composer.composerHeaders','{"allComposers":[]}');`,
    });

    await sql.execSqlScript({
      ...ctx,
      database: workspace.workspaceDbPath,
      sql: 'PRAGMA journal_mode=WAL; CREATE TABLE ItemTable(key TEXT PRIMARY KEY,value BLOB);',
    });

    const archive = path.join(root, 'input.zip');
    const writer = await BundleWriter.open(archive);

    await writer.beginChat({ composerId: chat, name: 'Performance fixture' });
    await writer.writeComposer({ _v: 18, composerId: chat }, 'absent');

    const body =
      process.env.CCT_BENCH_RANDOM === '1'
        ? randomBytes(Math.ceil((payloadBytes * 3) / 4))
            .toString('base64')
            .slice(0, payloadBytes)
        : 'x'.repeat(payloadBytes);

    for (let index = 0; index < count; index++) {
      const bubble = `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, '0')}`;

      await writer.writeBubble(bubble, {
        composerId: chat,
        bubbleId: bubble,
        text: body,
      });
    }

    await writer.endChat();
    await writer.finish();
    let writeStarted = 0;
    let writePhaseMs = 0;

    ctx.onPhase = (phase) => {
      if (phase === 'write' && !writeStarted) writeStarted = performance.now();
      if (phase === 'global-commit' && writeStarted)
        writePhaseMs += performance.now() - writeStarted;
    };

    let maxBatchMs = 0;
    let imported: Awaited<ReturnType<typeof importFromBundle>>;
    const start = performance.now();
    const eventsPath = path.join(project, 'out/transfer-events.js');

    let observe:
      typeof import('../src/transfer-events').observeTransfer | undefined;

    try {
      observe = (require(eventsPath) as typeof import('../src/transfer-events'))
        .observeTransfer;
    } catch {
      /* Baseline has no structured observer. */
    }

    if (observe)
      imported = await observe(
        {
          event: (event) => {
            if (
              event.action === 'Commit prepared batch' &&
              event.status === 'completed'
            )
              maxBatchMs = Math.max(maxBatchMs, event.elapsedMs || 0);
          },
        },
        () => importFromBundle(ctx, archive, workspace),
      );
    else imported = await importFromBundle(ctx, archive, workspace);
    const importMs = performance.now() - start;
    const exportedPath = path.join(root, 'output.zip');
    const exportStart = performance.now();

    await exportToFile({ ...ctx, onPhase: undefined }, workspace, exportedPath);
    const exportMs = performance.now() - exportStart;
    const repeatStart = performance.now();

    const repeated = await importFromBundle(
      { ...ctx, onPhase: undefined },
      archive,
      workspace,
    );

    const repeatMs = performance.now() - repeatStart;

    process.stdout.write(
      JSON.stringify(
        {
          messages: count,
          messageBytes: payloadBytes,
          logicalPayloadBytes: count * payloadBytes,
          payload:
            process.env.CCT_BENCH_RANDOM === '1'
              ? 'random-base64'
              : 'repeated-x',
          imported: imported.imported,
          repeatedImported: repeated.imported,
          importMs: Math.round(importMs),
          writePhaseMs: Math.round(writePhaseMs),
          maxBatchMs: maxBatchMs || undefined,
          exportMs: Math.round(exportMs),
          repeatMs: Math.round(repeatMs),
          peakRssBytes: rss,
          zipBytes: (await fs.stat(exportedPath)).size,
        },
        null,
        2,
      ) + '\n',
    );
  } finally {
    clearInterval(sample);
    await fs.rm(root, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
