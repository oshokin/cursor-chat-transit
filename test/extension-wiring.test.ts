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
const dispose = { dispose() {} };
/** Webview view provider captured from activation. */
let provider: unknown;
/** vscode module stub: commands, Output channels, and configuration. */
const fakeVscode = {
  UIKind: { Desktop: 1, Web: 2 },
  env: { uiKind: 1, appName: 'Cursor' },
  window: {
    createOutputChannel(name: string) {
      channels.push(name);
      return { ...dispose, name, appendLine() {}, show() {}, clear() {} };
    },
    registerWebviewViewProvider(_id: string, value: unknown) {
      provider = value;
      return dispose;
    },
    showWarningMessage(message: string) {
      warnings.push(message);
    },
    showErrorMessage(message: string) {
      errors.push(message);
      return Promise.resolve(undefined);
    },
  },
  commands: {
    registerCommand(id: string, callback: () => unknown) {
      commands.set(id, callback);
      return dispose;
    },
    executeCommand() {
      return Promise.resolve();
    },
    getCommands() {
      return Promise.resolve([]);
    },
  },
  workspace: {
    getConfiguration() {
      return {
        inspect() {
          return undefined;
        },
        get() {
          throw new Error('Fixture has no profile');
        },
      };
    },
  },
};
/** Node module loader, used to intercept `require('vscode')`. */
const loader = Module as unknown as {
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

test('activation still registers all commands, both logs and the sidebar after extraction', () => {
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
      'cursorChatTransit.showDiagnosticOutput',
    ].sort(),
  );
  assert.deepEqual(channels, [
    'Cursor Chat Transit — Operations',
    'Cursor Chat Transit — Diagnostics',
  ]);
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
    'A previous transfer needs attention. Open the operation log for recovery steps.',
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
    appendLine() {},
    info() {},
    warn() {},
    error(message: string) {
      logLines.push(message);
    },
    show() {},
    dispose() {},
  });
  assert.match(logLines[0] || '', /\/tmp\/x\.lock/);
  assert.match(logLines[0] || '', /delete only this lock/);
  assert.equal(
    errors[0],
    'A previous transfer needs attention. Open the operation log for recovery steps.',
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
    appendLine() {},
    info() {},
    warn() {},
    error(message: string) {
      logLines.push(message);
    },
    show() {},
    dispose() {},
  });
  assert.match(logLines[0] || '', /inconsistent-target/);
  assert.match(logLines[0] || '', /target=tgt/);
  assert.equal(
    errors[0],
    'The previous import needs checking. No new copies were created.',
  );
});
