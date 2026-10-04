import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import type * as vscode from 'vscode';
import type { TransitLog } from '../src/output-ui';
import type { StatisticsJob, StatisticsUpdate } from '../src/statistics';
import type { WorkspaceEntry } from '../src/types';

const jobs: StatisticsJob[] = [];
let abort: AbortController;
let cancelAfterFirst = false;
let preparations = 0;
let locks = 0;

const runtime = {
  uiState: {} as Record<string, unknown>,
  progressTimer: undefined as ReturnType<typeof setInterval> | undefined,
};

const loader = Module as unknown as {
  _load(id: string, parent: unknown, isMain: boolean): unknown;
};

const original = loader._load;

loader._load = function (id, parent, isMain) {
  if (id === 'vscode')
    return {
      ProgressLocation: { Notification: 15 },
      window: {
        withProgress: async (
          _opts: unknown,
          fn: (progress: { report(): void }, token: object) => Promise<void>,
        ) => fn({ report() {} }, {}),
        showInformationMessage: async () => {},
      },
    };
  if (id === './extension-state')
    return {
      runtime,
      withLock: async (_ctx: unknown, fn: () => Promise<void>) => {
        locks++;
        await fn();
      },
      setUi: (patch: object) => Object.assign(runtime.uiState, patch),
      linkedSignal: () => abort.signal,
      finishPhaseProgress: () => clearInterval(runtime.progressTimer),
    };
  if (id === './extension-workspaces')
    return {
      prepareSqlite: async () => {
        preparations++;

        return { executable: 'sqlite3', initFile: '' };
      },
    };
  if (id === './extension-settings') return { transferSettings: () => ({}) };
  if (id === './transfer-process')
    return {
      runTransfer: async (
        job: StatisticsJob,
        handlers: { onStatistics(row: StatisticsUpdate): void },
      ) => {
        jobs.push(job);
        assert.equal(job.kind, 'chat-statistics');
        if (job.kind === 'chat-statistics')
          for (const chat of job.chats || [{ composerId: 'all-chat' }])
            handlers.onStatistics({ key: chat.composerId, detail: 'Checked' });
        if (cancelAfterFirst) abort.abort();

        return { failed: 0 };
      },
    };

  return original.call(this, id, parent, isMain);
};

let check: typeof import('../src/extension-managed-check').checkManagedNodes;

try {
  check = require('../src/extension-managed-check').checkManagedNodes;
} finally {
  loader._load = original;
}

const a = { storageRoot: '/one', storageId: 'a' } as WorkspaceEntry;
const b = { storageRoot: '/one', storageId: 'b' } as WorkspaceEntry;
const log = { info() {}, warn() {}, error() {} } as unknown as TransitLog;

beforeEach(() => {
  jobs.length = 0;
  abort = new AbortController();
  cancelAfterFirst = false;
  preparations = locks = 0;
});

test('bulk checks group selected chats and read workspace headers in the same job', async () => {
  await check(
    {} as vscode.ExtensionContext,
    log,
    [
      { workspace: a, chat: { composerId: '1' } },
      { workspace: a, chat: { composerId: '2' } },
      { workspace: a, chat: { composerId: '1' } },
      { workspace: b },
      { workspace: b, chat: { composerId: 'covered' } },
    ],
    () => {},
  );

  assert.equal(locks, 1);
  assert.equal(preparations, 1);
  assert.equal(jobs.length, 2);

  assert.deepEqual(
    jobs[0].kind === 'chat-statistics' &&
      jobs[0].chats?.map((chat) => chat.composerId),
    ['1', '2'],
  );

  assert.equal(jobs[1].kind === 'chat-statistics' && jobs[1].chats, undefined);
});

test('bulk check cancellation stops later workspaces instead of opening the next progress job', async () => {
  cancelAfterFirst = true;

  await check(
    {} as vscode.ExtensionContext,
    log,
    [{ workspace: a }, { workspace: b }],
    () => {},
  );

  assert.equal(jobs.length, 1);
  assert.equal(runtime.uiState.status, 'cancelled');
});
