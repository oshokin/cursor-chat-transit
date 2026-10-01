import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type * as vscode from 'vscode';
import type { SidebarState } from '../src/sidebar-provider';
import { TransferError } from '../src/types';

/** Synthetic storage identity; no user profile or chat database is opened. */
const workspace = { storageId: 'fixture', storageRoot: '/fixture' };
/** Realistic headers for the all-chats and selected-chat flows. */
const chats = [{ composerId: 'one', name: 'First chat' }];

/** Dialog responses and transfer calls observed at the I/O boundaries. */
const host = {
  /** Dialog stage to cancel, or empty to proceed. */
  cancel: '',
  /** When true, the export picker selects individual chats instead of all chats. */
  selected: false,
  /** How many chats the stub import reports as newly written. */
  imported: 1,
  /** How many of those chats the stub reports as history-only. */
  historyOnly: 0,
  /** How many chats the stub reports as skipped. */
  skipped: 0,
  /** Whether the stub export reports a complete snapshot. */
  exportComplete: true,
  /** TransferError code to throw from the stub, or empty to succeed. */
  failureCode: '',
  /** Ordered dialog and transfer stages observed by the test. */
  events: [] as string[],
  /** Sidebar snapshots captured on each refresh. */
  states: [] as SidebarState[],
  /** How many times the stub export path ran. */
  exports: 0,
  /** How many times the stub import path ran. */
  imports: 0,
  /** Optional hook invoked while the export mode picker is open. */
  onMode: undefined as (() => Promise<void>) | undefined,
};

/** Assert the UI while a real command is awaiting a simulated native dialog. */
function waiting(stage: string, title: string): void {
  host.events.push(stage);
  assert.equal(state.runtime.uiState.status, 'waiting');
  assert.equal(state.runtime.uiState.statusTitle, title);
  assert.equal(state.runtime.busy, true);
  assert.equal(state.runtime.uiState.canCancel, false);
  assert.equal(state.runtime.uiState.progress, undefined);
  assert.equal(host.exports + host.imports, 0);
}

/** Minimal VS Code surface used by the actual import and export commands. */
const fakeVscode = {
  Uri: { file: (fsPath: string) => ({ scheme: 'file', fsPath }) },
  ProgressLocation: { Notification: 15 },
  workspace: { getConfiguration: () => ({ inspect: () => undefined }) },
  window: {
    /** Choose a mode or a chat selection, or cancel at that step. */
    async showQuickPick(_items: unknown, options: { canPickMany?: boolean }) {
      if (options.canPickMany) {
        waiting('chats', 'Select chats to export');
        if (host.cancel === 'chats') return undefined;

        return host.cancel === 'empty' ? [] : [{ id: 'one' }];
      }

      waiting('mode', 'Choose chats to export');
      await host.onMode?.();
      if (host.cancel === 'mode') return undefined;

      return { value: host.selected ? 'select' : 'all' };
    },
    /** Return a temporary save path unless the test cancels the dialog. */
    async showSaveDialog() {
      waiting('save', 'Choose where to save');

      return host.cancel === 'save'
        ? undefined
        : fakeVscode.Uri.file(path.join(os.tmpdir(), 'fixture.json'));
    },
    /** Return a temporary export path unless the test cancels the dialog. */
    async showOpenDialog() {
      waiting('open', 'Choose an export file');

      return host.cancel === 'open'
        ? undefined
        : [fakeVscode.Uri.file(path.join(os.tmpdir(), 'fixture.json'))];
    },
    /** Run the progress callback with an inert reporter and token. */
    async withProgress(
      _options: unknown,
      run: (...args: unknown[]) => unknown,
    ) {
      assert.equal(state.runtime.uiState.status, 'running');
      host.events.push('progress');

      return run(
        {
          /** Ignore a progress increment. */
          report() {},
        },
        {
          isCancellationRequested: false,
          /** Ignore a cancellation subscription. */
          onCancellationRequested() {},
        },
      );
    },
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
  },
};

/** Host discovery and workspace selection stand in for external storage. */
const workspaces = {
  /** Return the fixture workspace without scanning disk. */
  async hostState() {
    return { sqlite: {}, userDir: '/fixture', entries: [workspace] };
  },
  /** Return the fixture workspace unless the test cancels the picker. */
  async pickWorkspace() {
    waiting('workspace', 'Choose a workspace');

    return host.cancel === 'workspace' ? undefined : workspace;
  },
};

/** Real command orchestration with transfer I/O replaced by observable stubs. */
const transfer = {
  /** Return the fixture chat list and assert that listing is running. */
  async listWorkspaceChats() {
    assert.equal(state.runtime.uiState.status, 'running');
    assert.equal(state.runtime.uiState.statusTitle, 'Loading chat list…');
    host.events.push('list');

    return { allComposers: chats };
  },
  /** Count an export and optionally throw the requested failure. */
  async exportToFile() {
    assert.equal(state.runtime.uiState.statusTitle, 'Exporting chats…');
    assert.equal(state.runtime.uiState.statusDetail, 'Reading selected chats.');
    host.exports += 1;
    failIfRequested();

    return { exported: 1, selected: 1, complete: host.exportComplete };
  },
  /** Count an import and optionally throw the requested failure. */
  async importFromObject() {
    assert.equal(state.runtime.uiState.statusTitle, 'Importing…');
    host.imports += 1;
    failIfRequested();

    return {
      imported: host.imported,
      alreadyImported: host.imported === 0 && host.skipped === 0 ? 1 : 0,
      newVersions: 0,
      historyOnly: host.historyOnly,
      skipped: host.skipped,
      alreadyImportedChats: [],
      newVersionChats: [],
      skippedChats: [],
    };
  },
};

/** Inject an expected transfer failure without opening a real database. */
function failIfRequested(): void {
  if (!host.failureCode) return;
  const error = new TransferError('Fixture transfer failure');

  error.code = host.failureCode;

  throw error;
}

/** The log still runs normally; only its output sink is inert. */
const operations = {
  /** Ignore an informational line. */
  info() {},
  /** Ignore a warning line. */
  warn() {},
  /** Ignore an error line. */
  error() {},
  /** Ignore an appended line. */
  appendLine() {},
  /** Ignore a request to reveal the channel. */
  show() {},
  /** Ignore disposal of the stub channel. */
  dispose() {},
};

/** Node loader interception matches the project's existing fake-vscode tests. */
const loader = Module as unknown as {
  /** Node's internal module loader, replaced for the duration of the test. */
  _load(
    id: string,
    parent: {
      /** Path of the module that issued the load, when Node provides it. */
      filename?: string;
    },
    isMain: boolean,
  ): unknown;
};

/** Saved loader restored immediately after loading the subject modules. */
const original = loader._load;

loader._load = function (id, parent, isMain) {
  if (id === 'vscode') return fakeVscode;

  if (parent?.filename?.includes('extension-')) {
    if (id === './extension-workspaces') return workspaces;
    if (id === './transfer') return transfer;

    if (id === './export-transfer') {
      return { listWorkspaceChats: transfer.listWorkspaceChats };
    }

    if (id === './file-dialogs')
      return {
        JSON_FILTER: { 'Cursor chat export': ['zip'] },
        ZIP_FILTER: { 'Cursor chat export': ['zip'] },
        importDialogOptions: () => ({}),
        localBundlePath: async () => {
          host.events.push('read');
          assert.equal(state.runtime.uiState.status, 'running');

          assert.equal(
            state.runtime.uiState.statusDetail,
            'Reading export file…',
          );

          return '/tmp/fixture.cursor-chat.zip';
        },
      };

    if (id === './transfer-process')
      return {
        async runTransfer(job: { kind: string }) {
          if (job.kind === 'export') return transfer.exportToFile();

          return transfer.importFromObject();
        },
      };
  }

  return original.call(this, id, parent, isMain);
};

/** Actual state and command implementations loaded against the I/O stubs. */
let state: typeof import('../src/extension-state');
/** Export command under test, loaded against the I/O stubs. */
let doExport: typeof import('../src/extension-export').doExport;
/** Import command under test, loaded against the I/O stubs. */
let doImport: typeof import('../src/extension-import').doImport;
/** Actual error presenter used by the registered commands. */
let showFail: typeof import('../src/extension-errors').showFail;

try {
  state = require('../src/extension-state');
  ({ doExport } = require('../src/extension-export'));
  ({ doImport } = require('../src/extension-import'));
  ({ showFail } = require('../src/extension-errors'));
} finally {
  loader._load = original;
}

beforeEach(() => {
  Object.assign(host, {
    cancel: '',
    selected: false,
    imported: 1,
    historyOnly: 0,
    skipped: 0,
    exportComplete: true,
    failureCode: '',
    events: [],
    states: [],
    exports: 0,
    imports: 0,
    onMode: undefined,
  });

  state.runtime.busy = false;
  state.runtime.uiState = state.idleState();
  state.runtime.sourceWorkspace = workspace as never;

  state.runtime.sidebar = {
    /** Record each sidebar refresh. */
    refresh() {
      host.states.push({ ...state.runtime.uiState });
    },
  } as never;
});

/** Exercise the real lock lifecycle around a command and remove its temporary files. */
async function run(kind: 'export' | 'import'): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'transit-dialogs-'));

  const context = {
    globalStorageUri: { fsPath: dir },
    globalState: {
      /** Return no stored global state. */
      get() {},
      /** Ignore a global-state write. */
      async update() {},
    },
  } as unknown as vscode.ExtensionContext;

  try {
    await state
      .withLock(context, () =>
        (kind === 'export' ? doExport : doImport)({ context, operations }),
      )
      .catch((error: unknown) => showFail(kind, error, operations));

    assert.equal(state.runtime.busy, false);
    assert.equal(state.runtime.uiState.busy, false);
    assert.equal(state.runtime.uiState.canCancel, false);
    assert.equal(state.runtime.uiState.progress, undefined);
    assert.deepEqual(await fs.readdir(dir), []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('export waits at each dialog and only reads selected chats after Save', async () => {
  host.selected = true;
  state.runtime.sourceWorkspace = undefined;
  await run('export');

  assert.deepEqual(host.events, [
    'workspace',
    'list',
    'mode',
    'chats',
    'save',
    'progress',
  ]);

  assert.equal(host.exports, 1);
  assert.equal(state.runtime.uiState.status, 'completed');
});

test('an unresolved chat picker keeps the lock without claiming export progress', async () => {
  let release!: () => void;
  let entered!: () => void;

  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });

  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });

  host.onMode = async () => {
    entered();
    await hold;
  };

  const pending = run('export');

  try {
    await reached;
    await new Promise<void>((resolve) => setImmediate(resolve));
    waiting('held', 'Choose chats to export');
    assert.equal(host.events.includes('progress'), false);
  } finally {
    release();
  }

  await pending;
  assert.equal(host.exports, 1);
});

for (const stage of ['workspace', 'mode', 'chats', 'empty', 'save']) {
  test(`cancelling export at ${stage} never starts transfer and releases the lock`, async () => {
    host.cancel = stage;
    host.selected = true;
    if (stage === 'workspace') state.runtime.sourceWorkspace = undefined;
    await run('export');
    assert.equal(host.exports, 0);
    assert.equal(host.events.includes('progress'), false);
    assert.equal(state.runtime.uiState.status, 'cancelled');

    assert.equal(
      host.states.some((s) => /Reading selected chats/.test(s.statusDetail)),
      false,
    );
  });
}

test('import waits for file and destination, then starts reading the export', async () => {
  state.runtime.sourceWorkspace = undefined;
  await run('import');
  assert.deepEqual(host.events, ['open', 'workspace', 'progress', 'read']);
  assert.equal(host.imports, 1);
  assert.equal(state.runtime.uiState.status, 'completed');
});

for (const stage of ['open', 'workspace']) {
  test(`cancelling import at ${stage} never reads the file or writes chats`, async () => {
    host.cancel = stage;
    state.runtime.sourceWorkspace = undefined;
    await run('import');
    assert.equal(host.imports, 0);
    assert.equal(host.events.includes('read'), false);
    assert.equal(state.runtime.uiState.status, 'cancelled');
  });
}

for (const [name, imported, historyOnly, skipped, expected] of [
  ['new chats', 1, 0, 0, true],
  ['already imported', 0, 0, 0, false],
  ['usable partial recovery', 1, 1, 1, true],
  ['all chats skipped', 0, 0, 1, false],
] as const) {
  test(`import restart eligibility follows the result: ${name}`, async () => {
    Object.assign(host, { imported, historyOnly, skipped });
    state.runtime.uiState.importNeedsRestart = true;
    await run('import');
    assert.equal(state.runtime.uiState.importNeedsRestart, expected);
    assert.equal(host.states[0]?.importNeedsRestart, false);
  });
}

for (const outcome of ['completed', 'incomplete', 'failed', 'cancelled']) {
  test(`export ${outcome} clears restart eligibility left by an earlier import`, async () => {
    state.runtime.uiState.importNeedsRestart = true;
    if (outcome === 'incomplete') host.exportComplete = false;
    if (outcome === 'failed') host.failureCode = 'RESOURCE_CONFLICT';
    if (outcome === 'cancelled') host.cancel = 'mode';
    await run('export');
    assert.equal(state.runtime.uiState.status, outcome);
    assert.equal(state.runtime.uiState.importNeedsRestart, false);

    assert.equal(
      host.states.every((s) => s.importNeedsRestart === false),
      true,
    );
  });
}

for (const code of ['RESOURCE_CONFLICT', 'PARTIAL']) {
  test(`import error ${code} offers recovery, not Quit`, async () => {
    state.runtime.uiState.importNeedsRestart = true;
    host.failureCode = code;
    await run('import');

    assert.equal(
      state.runtime.uiState.status,
      code === 'PARTIAL' ? 'partial' : 'failed',
    );

    assert.equal(state.runtime.uiState.importNeedsRestart, false);
  });
}

test('cancelled import clears restart eligibility from the previous result', async () => {
  state.runtime.uiState.importNeedsRestart = true;
  host.cancel = 'open';
  await run('import');
  assert.equal(state.runtime.uiState.status, 'cancelled');
  assert.equal(state.runtime.uiState.importNeedsRestart, false);
});
