import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type * as vscode from 'vscode';
import { TransferError } from '../src/types';

// A small contract stub, not a claim that the real Extension Host was launched.
/** Commands registered through the vscode stub. */
const commands = new Map<string, () => unknown>();
/** Output channel names created during activation. */
const channels: string[] = [];
/** Warning toasts captured from the stub. */
const warnings: string[] = [];
/** Error toasts captured from the stub. */
const errors: string[] = [];

/** Disposable object returned by stub registrations. */
const dispose = {
  /** Release a registration; the stub has nothing to tear down. */
  dispose() {},
};

/** Webview view provider captured from activation. */
let provider: unknown;

/** vscode module stub: commands, Output channels, and configuration. */
const fakeVscode = {
  UIKind: { Desktop: 1, Web: 2 },
  env: { uiKind: 1, appName: 'Cursor' },
  window: {
    /** Record the Output channel name and return inert log methods. */
    createOutputChannel(name: string) {
      channels.push(name);

      return {
        ...dispose,
        name,
        /** Ignore a line written to the stub channel. */
        appendLine() {},
        /** Ignore a request to reveal the stub channel. */
        show() {},
        /** Ignore a request to clear the stub channel. */
        clear() {},
      };
    },
    /** Remember the sidebar provider registered during activation. */
    registerWebviewViewProvider(_id: string, value: unknown) {
      provider = value;

      return dispose;
    },
    /** Record a warning toast. */
    showWarningMessage(message: string) {
      warnings.push(message);
    },
    /** Record an error toast. */
    showErrorMessage(message: string) {
      errors.push(message);

      return Promise.resolve(undefined);
    },
  },
  commands: {
    /** Store a command callback under its id. */
    registerCommand(id: string, callback: () => unknown) {
      commands.set(id, callback);

      return dispose;
    },
    /** Resolve a command without invoking the real workbench. */
    executeCommand() {
      return Promise.resolve();
    },
    /** Report that this stub exposes no extra commands. */
    getCommands() {
      return Promise.resolve([]);
    },
  },
  workspace: {
    /** Return a configuration object with no stored profile. */
    getConfiguration() {
      return {
        /** Report that no setting value is inspected. */
        inspect() {
          return undefined;
        },
        /** Refuse a direct read; this fixture has no profile. */
        get() {
          throw new Error('Fixture has no profile');
        },
      };
    },
  },
};

/** Node module loader, used to intercept `require('vscode')`. */
const loader = Module as unknown as {
  /** Node's internal module loader, replaced for the duration of the test. */
  _load(id: string, parent: unknown, isMain: boolean): unknown;
};

/** Original Node module loader. */
const original = loader._load;

loader._load = function (id, parent, isMain) {
  return id === 'vscode' ? fakeVscode : original.call(this, id, parent, isMain);
};

/** Extension module loaded against the vscode stub. */
let extension: typeof import('../src/extension');
/** Shared operation state module loaded against the same stub. */
let state: typeof import('../src/extension-state');
/** Failure copy loaded against the same stub. */
let errorsMod: typeof import('../src/extension-errors');

try {
  extension = require('../src/extension') as typeof extension;
  state = require('../src/extension-state') as typeof state;
  errorsMod = require('../src/extension-errors') as typeof errorsMod;
} finally {
  loader._load = original;
}

test('activation still registers all commands, one operation log and the sidebar after extraction', () => {
  const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;

  extension.activate(context);

  assert.deepEqual(
    [...commands.keys()].sort(),
    [
      'cursorChatTransit.export',
      'cursorChatTransit.import',
      'cursorChatTransit.exportCurrentWorkspace',
      'cursorChatTransit.diagnostics',
      'cursorChatTransit.showOutput',
    ].sort(),
  );

  assert.deepEqual(channels, ['Cursor Chat Transit — Operations']);

  assert.ok(provider);
  assert.equal(state.runtime.sidebar, provider);
  assert.equal(state.runtime.uiState.status, 'idle');
});

test('operation lock excludes a second command and releases shared state after failure', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'transit-host-'));

  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const context = {
    globalStorageUri: { fsPath: dir },
  } as vscode.ExtensionContext;

  let unblock!: () => void;
  let entered!: () => void;

  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });

  const hold = new Promise<void>((resolve) => {
    unblock = resolve;
  });

  const first = state.withLock(context, async () => {
    entered();
    await hold;

    throw new Error('injected failure');
  });

  const rejection = assert.rejects(first, /injected failure/);

  await reached;
  assert.equal(state.runtime.busy, true);
  let secondRan = false;

  await state.withLock(context, async () => {
    secondRan = true;
  });

  assert.equal(secondRan, false);
  assert.equal(warnings.length, 1);
  unblock();
  await rejection;
  assert.equal(state.runtime.busy, false);
  assert.equal(state.runtime.uiState.canCancel, false);

  assert.equal(
    await state.withLock(context, async () => 'available'),
    'available',
  );
});

test('sidebar and notification cancellation target the same active operation', async () => {
  let cancel = () => {};

  const signal = state.linkedSignal({
    isCancellationRequested: false,
    /** Capture the host cancellation callback. */
    onCancellationRequested(callback: () => void) {
      cancel = callback;

      return dispose;
    },
  } as vscode.CancellationToken);

  assert.equal(signal.aborted, false);
  state.runtime.activeAbort?.abort();
  assert.equal(signal.aborted, true);

  const next = state.linkedSignal({
    isCancellationRequested: false,
    /** Replace the captured cancellation callback. */
    onCancellationRequested(callback: () => void) {
      cancel = callback;

      return dispose;
    },
  } as vscode.CancellationToken);

  cancel();
  assert.equal(next.aborted, true);
  state.runtime.activeAbort = undefined;
});

test('leftover locks keep recovery copy distinct from a live lock', () => {
  const live = new TransferError('Another operation (pid 1).');

  live.code = 'LOCKED';

  assert.equal(
    errorsMod.userFacingError(live),
    'Another Cursor Chat Transit operation is running.',
  );

  const leftover = new TransferError(
    'A previous Cursor Chat Transit operation did not finish (pid 9). then delete only this lock file and retry:\n/tmp/transfer.lock',
  );

  leftover.code = 'LOCK_RECOVERY_REQUIRED';

  assert.equal(
    errorsMod.userFacingError(leftover),
    'A previous transfer stopped. Clear its stale lock, then retry.',
  );

  const partial = new TransferError('partial');

  partial.code = 'PARTIAL';

  assert.equal(
    errorsMod.userFacingError(partial),
    'The import needs attention. Open the log before continuing.',
  );

  assert.doesNotMatch(errorsMod.userFacingError(partial), /No changes made/);
  assert.doesNotMatch(errorsMod.userFacingError(partial), /Restart fixes/);
});

test('showFail writes leftover-lock recovery to the operation log', () => {
  const leftover = new TransferError(
    'A previous Cursor Chat Transit operation did not finish (pid 9). Close windows, then delete only this lock file:\n/tmp/x.lock',
  );

  leftover.code = 'LOCK_RECOVERY_REQUIRED';
  const logLines: string[] = [];

  errors.length = 0;

  errorsMod.showFail('Import', leftover, {
    /** Ignore an appended line. */
    appendLine() {},
    /** Ignore an informational line. */
    info() {},
    /** Ignore a warning line. */
    warn() {},
    /** Keep the error text written for the leftover lock. */
    error(message: string) {
      logLines.push(message);
    },
    /** Ignore a request to reveal the channel. */
    show() {},
    /** Ignore disposal of the stub channel. */
    dispose() {},
  });

  assert.match(logLines[0] || '', /^Import failed:/);
  assert.match(logLines[1] || '', /\/tmp\/x\.lock/);
  assert.match(logLines[1] || '', /delete only this lock/);

  assert.equal(
    errors[0],
    'A previous transfer stopped. Clear its stale lock, then retry.',
  );

  assert.equal(
    state.runtime.uiState.statusTitle,
    'A previous transfer needs attention',
  );
});

test('showFail writes NEEDS_ATTENTION target facts to the operation log', () => {
  const err = new TransferError(
    'The previous import needs checking. No new copies were created.',
  );

  err.code = 'NEEDS_ATTENTION';

  err.detail =
    'inconsistent-target source=src target=tgt body=absent bubbles=0 workspaceList=present workspaceSelected=present workspaceHeaders=absent globalHeader=present globalHeadersTable=absent verdict=inconsistent';

  const logLines: string[] = [];

  errors.length = 0;

  errorsMod.showFail('Import', err, {
    /** Ignore an appended line. */
    appendLine() {},
    /** Ignore an informational line. */
    info() {},
    /** Ignore a warning line. */
    warn() {},
    /** Keep the diagnostic line written for this failure. */
    error(message: string) {
      logLines.push(message);
    },
    /** Ignore a request to reveal the channel. */
    show() {},
    /** Ignore disposal of the stub channel. */
    dispose() {},
  });

  assert.match(logLines[0] || '', /^Import failed:/);
  assert.match(logLines[1] || '', /inconsistent-target/);
  assert.match(logLines[1] || '', /target=tgt/);

  assert.equal(
    errors[0],
    'The previous import needs checking. No new copies were created.',
  );
});

test('sidebar and operation log share the start and frozen total for every terminal outcome', () => {
  const { startOperationLog } =
    require('../src/operation-log') as typeof import('../src/operation-log');

  const { asTransitLog } =
    require('../src/output-ui') as typeof import('../src/output-ui');

  for (const outcome of [
    'completed',
    'incomplete',
    'cancelled',
    'failed',
    'partial',
  ] as const) {
    const lines: string[] = [];
    let now = performance.now() - 14000;
    const start = now;

    const log = startOperationLog(
      asTransitLog({
        appendLine: (line) => lines.push(line),
        show() {},
        dispose() {},
      }),
      'import',
      () => now,
    );

    state.runtime.busy = true;
    state.setUi({ status: 'running' });
    const phase = state.attachPhaseProgress({ report() {} }, log, 'import');

    phase('validate', { chatName: 'Last chat' });
    assert.match(state.runtime.uiState.timingLabel!, /Elapsed 0m 14s/);
    now = start + 87682;
    log.finish(outcome);
    state.finishPhaseProgress(log);
    assert.equal(state.runtime.uiState.timingLabel, 'Total 1m 27s');
    assert.match(lines.at(-1)!, /elapsedMs=87682 \(1m 27s\)/);
    assert.equal(state.runtime.uiState.stageLabel, '');
    assert.equal(state.runtime.uiState.currentItem, '');
    assert.equal(state.runtime.progressTimer, undefined);
    now += 10000;
    state.finishPhaseProgress(log);
    assert.equal(state.runtime.uiState.timingLabel, 'Total 1m 27s');
    state.runtime.busy = false;
  }
});
