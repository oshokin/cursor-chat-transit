import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import type * as vscode from 'vscode';
import type { TransitLog } from '../src/output-ui';
import type { WorkspaceEntry } from '../src/types';
import type {
  ManagedDeleteRequest,
  ManagedDeleteResult,
} from '../src/deletion-types';

const events: string[] = [];
let confirmationTitle = '';
let confirmationDetail = '';
let decision: { title: string } | undefined;
let busy = false;
let workerFailure = false;
let outcome: ManagedDeleteResult;
const ui: Record<string, unknown> = {};

const runtime = {
  uiState: ui,
  progressTimer: undefined as ReturnType<typeof setInterval> | undefined,
};

const fake = {
  workspace: {},
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
      listHostEntries: () => ({
        entries: [],
        userDir: '/fixture',
        identity: undefined,
      }),
      currentWorkspaceDatabase: () => undefined,
    };
  if (id === './transfer-process')
    return {
      runTransfer: async (job: {
        kind: string;
        busyTimeoutMs: number;
        requests?: ManagedDeleteRequest[];
      }) => {
        assert.equal(job.busyTimeoutMs, 0);
        events.push(job.kind);
        if (job.kind === 'prepare-managed-delete')
          return {
            ok: true,
            plan: {
              userDataRoot: '/fixture',
              targets: (job.requests || []).map((request) => ({
                kind: request.kind,
                workspace: request.workspace,
                ids: request.kind === 'chats' ? request.ids : [],
                token: 't',
                name: request.workspace.storageId,
                location: 'This computer',
                pathLabel: '/demo',
              })),
            },
          };
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

const targets: ManagedDeleteRequest[] = [
  { kind: 'chats', workspace, ids: ['chat'] },
];

beforeEach(() => {
  events.length = 0;
  decision = undefined;
  busy = workerFailure = false;

  outcome = {
    outcomes: [
      {
        kind: 'chats',
        workspaceKey: '/fixture/ws',
        label: 'test',
        chatIdsDeleted: ['chat'],
        chatIdsSkipped: [],
        storage: 'not-requested',
      },
    ],
  };

  for (const key of Object.keys(ui)) delete ui[key];
});

test('cancelled deletion performs no worker job and preserves a prior restart requirement', async () => {
  ui.importNeedsRestart = true;
  assert.equal(await remove(context, log, targets), false);

  assert.deepEqual(events, [
    'lock',
    'prepare-managed-delete',
    'confirm',
    'unlock',
  ]);

  assert.equal(ui.importNeedsRestart, true);
});

test('busy operation cannot start a deletion or quit Cursor', async () => {
  busy = true;
  decision = { title: 'Delete chats' };
  assert.equal(await remove(context, log, targets), false);
  assert.deepEqual(events, []);
});

test('confirmed deletion releases its lock despite an undismissed notice and enables Quit', async () => {
  decision = { title: 'Delete chats' };
  assert.equal(await remove(context, log, targets), true);

  assert.deepEqual(events, [
    'lock',
    'prepare-managed-delete',
    'confirm',
    'delete-managed-data',
    'unlock',
  ]);

  assert.equal(ui.importNeedsRestart, true);
  assert.equal(ui.status, 'completed');
  assert.equal(runtime.progressTimer, undefined);
});

test('skipped-only result does not enable Quit or claim a mutation', async () => {
  decision = { title: 'Delete chats' };

  outcome = {
    outcomes: [
      {
        kind: 'chats',
        workspaceKey: '/fixture/ws',
        label: 'test',
        chatIdsDeleted: [],
        chatIdsSkipped: ['shared chat'],
        storage: 'not-requested',
      },
    ],
  };

  assert.equal(await remove(context, log, targets), false);
  assert.equal(ui.importNeedsRestart, false);
  assert.equal(ui.status, 'incomplete');
});

test('partial cancellation retains committed counts and enables Quit', async () => {
  decision = { title: 'Delete chats' };

  outcome = {
    cancelled: true,
    error: 'Cancelled',
    outcomes: [
      {
        kind: 'chats',
        workspaceKey: '/fixture/ws',
        label: 'test',
        chatIdsDeleted: ['committed'],
        chatIdsSkipped: [],
        storage: 'not-requested',
      },
      {
        kind: 'workspace-data',
        workspaceKey: '/fixture/other',
        label: 'other',
        chatIdsDeleted: [],
        chatIdsSkipped: [],
        storage: 'not-started',
      },
    ],
  };

  assert.equal(await remove(context, log, targets), true);
  assert.equal(ui.status, 'cancelled');
  assert.equal(ui.importNeedsRestart, true);
  assert.match(String(ui.statusDetail), /1 chat/);
});

test('a lost worker result is reported as uncertain and releases all UI state', async () => {
  decision = { title: 'Delete chats' };
  workerFailure = true;
  assert.equal(await remove(context, log, targets), true);
  assert.equal(ui.status, 'failed');
  assert.equal(ui.importNeedsRestart, true);
  assert.equal(events.at(-1), 'unlock');
});

test('uncertain commit enables Quit even without a confirmed deleted count', async () => {
  decision = { title: 'Delete chats' };

  outcome = {
    uncertain: true,
    error: 'Commit acknowledgement lost',
    outcomes: [
      {
        kind: 'chats',
        workspaceKey: '/fixture/ws',
        label: 'test',
        chatIdsDeleted: [],
        chatIdsSkipped: [],
        storage: 'not-requested',
      },
    ],
  };

  assert.equal(await remove(context, log, targets), true);
  assert.equal(ui.importNeedsRestart, true);
  assert.match(String(ui.statusDetail), /final result is unknown/);
});

test('confirmation shows the resolved bulk count across workspaces', async () => {
  await remove(context, log, [
    { kind: 'chats', workspace, ids: ['a', 'b'] },
    {
      kind: 'chats',
      workspace: { ...workspace, storageId: 'other' },
      ids: ['c'],
    },
  ]);

  assert.equal(confirmationTitle, 'Delete 3 selected chats?');
  assert.match(confirmationDetail, /test — 2 chats/);
  assert.match(confirmationDetail, /other — 1 chat\b/);
  assert.equal(events.includes('delete-managed-data'), false);
});
