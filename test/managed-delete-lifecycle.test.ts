import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import type * as vscode from 'vscode';
import type { TransitLog } from '../src/output-ui';
import type { WorkspaceEntry } from '../src/types';
import type { DeleteResult } from '../src/deletion-types';

const events: string[] = [];
let confirmationTitle = '';
let confirmationDetail = '';
let decision: string | undefined;
let busy = false;
let workerFailure = false;
let outcome: DeleteResult;
const ui: Record<string, unknown> = {};

const runtime = {
  uiState: ui,
  progressTimer: undefined as ReturnType<typeof setInterval> | undefined,
};

const fake = {
  ProgressLocation: { Notification: 15 },
  commands: {
    executeCommand: async () => {
      assert.fail('Deletion must never quit Cursor automatically');
    },
  },
  window: {
    showWarningMessage: async (_title: string, options: { detail: string }) => {
      events.push('confirm');
      confirmationTitle = _title;
      confirmationDetail = options.detail;
      assert.match(options.detail, /Close all other Cursor windows/);
      assert.match(options.detail, /cannot be undone/);

      return decision;
    },
    showInformationMessage: () => new Promise(() => {}),
    withProgress: async (
      _options: unknown,
      run: (progress: { report(): void }, token: object) => Promise<unknown>,
    ) => run({ report() {} }, {}),
  },
};

const loader = Module as unknown as {
  _load(id: string, parent: unknown, isMain: boolean): unknown;
};

const original = loader._load;

loader._load = function (id, parent, isMain) {
  if (id === 'vscode') return fake;
  if (id === './extension-state')
    return {
      runtime,
      setUi: (patch: object) => Object.assign(ui, patch),
      linkedSignal: () => new AbortController().signal,
      finishPhaseProgress: () => {
        clearInterval(runtime.progressTimer);
        runtime.progressTimer = undefined;
      },
      withLock: async (_context: unknown, run: () => Promise<void>) => {
        if (busy) return;
        events.push('lock');

        try {
          await run();
        } finally {
          events.push('unlock');
        }
      },
    };
  if (id === './extension-settings')
    return { transferSettings: () => ({ busyTimeoutMs: 0 }) };
  if (id === './extension-workspaces')
    return {
      prepareSqlite: async () => ({ executable: 'sqlite3', initFile: '' }),
      listHostEntries: () => ({ entries: [] }),
    };
  if (id === './transfer-process')
    return {
      runTransfer: async (job: { kind: string; busyTimeoutMs: number }) => {
        assert.equal(job.kind, 'delete-chats');
        assert.equal(job.busyTimeoutMs, 0);
        events.push('worker');
        if (workerFailure) throw new Error('worker stopped');

        return outcome;
      },
    };

  return original.call(this, id, parent, isMain);
};

let remove: typeof import('../src/extension-managed-delete').deleteManagedChats;

try {
  remove = require('../src/extension-managed-delete').deleteManagedChats;
} finally {
  loader._load = original;
}

const context = {} as vscode.ExtensionContext;
const log = { info() {}, warn() {}, error() {} } as unknown as TransitLog;

const workspace = {
  storageId: 'test',
  globalDbPath: '/fixture/global',
} as WorkspaceEntry;

const targets = [{ workspace, ids: ['chat'] }];

beforeEach(() => {
  events.length = 0;
  decision = undefined;
  busy = workerFailure = false;
  outcome = { deleted: ['chat'], skipped: [] };
  for (const key of Object.keys(ui)) delete ui[key];
});

test('cancelled deletion performs no worker job and preserves a prior restart requirement', async () => {
  ui.importNeedsRestart = true;
  assert.equal(await remove(context, log, targets), false);
  assert.deepEqual(events, ['lock', 'confirm', 'unlock']);
  assert.equal(ui.importNeedsRestart, true);
});

test('busy operation cannot start a deletion or quit Cursor', async () => {
  busy = true;
  decision = 'Delete chats';
  assert.equal(await remove(context, log, targets), false);
  assert.deepEqual(events, []);
});

test('confirmed deletion releases its lock despite an undismissed notice and enables Quit', async () => {
  decision = 'Delete chats';
  assert.equal(await remove(context, log, targets), true);
  assert.deepEqual(events, ['lock', 'confirm', 'worker', 'unlock']);
  assert.equal(ui.importNeedsRestart, true);
  assert.equal(ui.status, 'completed');
  assert.equal(runtime.progressTimer, undefined);
});

test('skipped-only result does not enable Quit or claim a mutation', async () => {
  decision = 'Delete chats';
  outcome = { deleted: [], skipped: ['shared chat'] };
  assert.equal(await remove(context, log, targets), false);
  assert.equal(ui.importNeedsRestart, false);
  assert.equal(ui.status, 'incomplete');
});

test('partial cancellation retains committed counts and enables Quit', async () => {
  decision = 'Delete chats';

  outcome = {
    deleted: ['committed'],
    skipped: [],
    cancelled: true,
    error: 'Cancelled',
  };

  assert.equal(await remove(context, log, targets), true);
  assert.equal(ui.status, 'cancelled');
  assert.equal(ui.importNeedsRestart, true);
  assert.match(String(ui.statusDetail), /1 chats deleted/);
});

test('a lost worker result is reported as uncertain and releases all UI state', async () => {
  decision = 'Delete chats';
  workerFailure = true;
  assert.equal(await remove(context, log, targets), true);
  assert.equal(ui.status, 'failed');
  assert.equal(ui.importNeedsRestart, true);
  assert.equal(events.at(-1), 'unlock');
});

test('uncertain commit enables Quit even without a confirmed deleted count', async () => {
  decision = 'Delete chats';

  outcome = {
    deleted: [],
    skipped: [],
    error: 'Commit acknowledgement lost',
    uncertain: true,
  };

  assert.equal(await remove(context, log, targets), true);
  assert.equal(ui.importNeedsRestart, true);
  assert.match(String(ui.statusDetail), /final commit outcome unknown/);
});

test('confirmation shows the resolved bulk count across workspaces', async () => {
  await remove(context, log, [
    { workspace, ids: ['a', 'b'] },
    { workspace: { ...workspace, storageId: 'other' }, ids: ['c'] },
  ]);

  assert.equal(confirmationTitle, 'Delete 3 selected chats?');
  assert.match(confirmationDetail, /\(test\): 2 chats/);
  assert.match(confirmationDetail, /\(other\): 1 chat\b/);
  assert.equal(events.includes('worker'), false);
});
