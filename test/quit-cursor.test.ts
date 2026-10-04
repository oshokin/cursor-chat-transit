import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

/** Mutable host state; hooks pause real async boundaries without timers. */
const host = {
  /** vscode.UIKind value used by the capability check. */
  uiKind: 1,
  /** Host application name; must contain `Cursor` for the quit command. */
  appName: 'Cursor',
  /** Command ids the stub reports as available. */
  commands: ['workbench.action.quit'] as string[],
  /** True while a transfer holds the lock. */
  busy: false,
  /** True when the last completed import wrote chats that Cursor must reload. */
  importNeedsRestart: true,
  /** How many extension confirmation dialogs the stub opened. */
  dialogCount: 0,
  /** How many times `getCommands` ran. */
  commandReads: 0,
  /** Arguments passed to `executeCommand`. */
  executeCalls: [] as unknown[][],
  /** Information toasts shown to the user. */
  info: [] as string[],
  pendingNotices: false,
  /** Error toasts shown to the user. */
  errors: [] as string[],
  /** Info lines written to the operation log. */
  logInfo: [] as string[],
  /** Error lines written to the operation log. */
  logError: [] as string[],
  /** Optional pause after `getCommands` starts, used to mutate host state. */
  onGetCommands: undefined as (() => Promise<void>) | undefined,
  /** Optional pause after `executeCommand` starts, used to mutate host state. */
  onExecute: undefined as (() => Promise<void>) | undefined,
};

/** vscode.UIKind values used by the capability check. */
const UIKind = {
  /** Desktop host, required for native quit. */
  Desktop: 1,
  /** Web host, which never exposes `workbench.action.quit`. */
  Web: 2,
};

/** vscode module stub: env, commands, and native messages. */
const fakeVscode = {
  UIKind,
  env: {
    /** Current UI kind from the stubbed host. */
    get uiKind() {
      return host.uiKind;
    },
    /** Current application name from the stubbed host. */
    get appName() {
      return host.appName;
    },
  },
  commands: {
    /** Record a command-list read, then optionally pause before returning ids. */
    getCommands: async () => {
      host.commandReads += 1;
      await host.onGetCommands?.();

      return host.commands;
    },
    /** Record a command invocation, then optionally pause before resolving. */
    executeCommand: async (...args: unknown[]) => {
      host.executeCalls.push(args);
      await host.onExecute?.();
    },
  },
  window: {
    /** Capture an information toast. */
    showInformationMessage: async (message: string) => {
      host.info.push(message);
      if (host.pendingNotices) return new Promise<undefined>(() => {});

      return undefined;
    },
    /** Capture an error toast. */
    showErrorMessage: async (message: string) => {
      host.errors.push(message);
      if (host.pendingNotices) return new Promise<undefined>(() => {});

      return undefined;
    },
    /** Count an extension confirmation; this path must stay unused after the fix. */
    showWarningMessage: async () => {
      host.dialogCount += 1;

      return undefined;
    },
  },
};

/** Node module loader, used to intercept `require('vscode')`. */
const loader = Module as unknown as {
  /** Load a module by id; tests replace this to inject the vscode stub. */
  _load(id: string, parent: unknown, isMain: boolean): unknown;
};

/** Original Node module loader. */
const original = loader._load;

/** Serve the vscode stub, then restore ordinary module loading. */
loader._load = function loadVscodeStub(id, parent, isMain) {
  return id === 'vscode' ? fakeVscode : original.call(this, id, parent, isMain);
};

/** Quit helpers loaded against the vscode stub. */
let quitCursor: typeof import('../src/quit-cursor');

try {
  quitCursor = require('../src/quit-cursor') as typeof quitCursor;
} finally {
  loader._load = original;
}

/** Reset recorded host state between cases. */
function reset(): void {
  host.uiKind = UIKind.Desktop;
  host.appName = 'Cursor';
  host.commands = ['workbench.action.quit'];
  host.busy = false;
  host.importNeedsRestart = true;
  host.dialogCount = 0;
  host.commandReads = 0;
  host.executeCalls = [];
  host.info = [];
  host.pendingNotices = false;
  host.errors = [];
  host.logInfo = [];
  host.logError = [];
  host.onGetCommands = undefined;
  host.onExecute = undefined;
}

/** Guarded action bound to the current host.busy and restart flags. */
function action(): () => Promise<void> {
  return quitCursor.createQuitCursorAction(
    () => host.busy,
    () => host.importNeedsRestart,
    {
      /** Append an info line to the captured operation log. */
      info: (message) => host.logInfo.push(message),
      /** Append an error line to the captured operation log. */
      error: (message) => host.logError.push(message),
    },
  );
}

/** Handshake used to pause a host call, mutate state, then resume it. */
interface QuitTestGate {
  /** Resolves when the paused host call has started. */
  entered: Promise<void>;
  /** Allow the paused host call to continue. */
  release: () => void;
  /** Host hook: signal entry, then wait for `release`. */
  run: () => Promise<void>;
}

/** Handshake: wait for entry, mutate host state, then release the pending call. */
function gate(): QuitTestGate {
  /** Completes `entered` when the paused call has started. */
  let enter!: () => void;
  /** Completes `released` so the paused call may continue. */
  let release!: () => void;

  /** Resolves when the paused host call has started. */
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });

  /** Resolves when the test allows the paused call to continue. */
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });

  return {
    entered,
    release,
    run: async () => {
      enter();
      await released;
    },
  };
}

test('canQuitCursor requires desktop Cursor and the native command', async () => {
  reset();
  assert.equal(await quitCursor.canQuitCursor(), true);
  host.appName = 'Visual Studio Code';
  assert.equal(await quitCursor.canQuitCursor(), false);
  host.appName = 'Cursor';
  host.uiKind = UIKind.Web;
  assert.equal(await quitCursor.canQuitCursor(), false);
  host.uiKind = UIKind.Desktop;
  host.commands = [];
  assert.equal(await quitCursor.canQuitCursor(), false);
});

test('Quit delegates to Cursor once without an extension confirmation', async () => {
  reset();
  await action()();
  assert.equal(host.dialogCount, 0);
  assert.deepEqual(host.executeCalls, [['workbench.action.quit']]);
  assert.deepEqual(host.info, []);
  assert.deepEqual(host.errors, []);
  assert.match(host.logInfo[0] || '', /Quit Cursor requested/);
});

test('busy on entry explains and does not request quit', async () => {
  reset();
  host.busy = true;
  await action()();
  assert.equal(host.dialogCount, 0);
  assert.equal(host.commandReads, 0);
  assert.deepEqual(host.executeCalls, []);
  assert.match(host.info[0] || '', /Wait for the current transfer/);
});

test('a missing command shows a manual instruction', async () => {
  reset();
  host.commands = [];
  await action()();
  assert.equal(host.dialogCount, 0);
  assert.deepEqual(host.executeCalls, []);
  assert.match(host.info[0] || '', /application menu/);
});

test('unsupported hosts never request quit', async () => {
  for (const env of [
    { appName: 'Visual Studio Code', uiKind: UIKind.Desktop },
    { appName: 'Cursor', uiKind: UIKind.Web },
  ]) {
    reset();
    Object.assign(host, env);
    await action()();
    assert.deepEqual(host.executeCalls, []);
    assert.equal(host.commandReads, 0);
    assert.equal(host.dialogCount, 0);
  }
});

test('a transfer starting during capability lookup blocks quit', async () => {
  reset();
  const lookup = gate();

  host.onGetCommands = lookup.run;
  const pending = action()();

  await lookup.entered;
  host.busy = true;
  lookup.release();
  await pending;
  assert.deepEqual(host.executeCalls, []);
  assert.equal(host.dialogCount, 0);
  assert.match(host.info[0] || '', /Wait for the current transfer/);
});

test('a new operation invalidates Quit even if it finishes during lookup', async () => {
  reset();
  const lookup = gate();

  host.onGetCommands = lookup.run;
  const pending = action()();

  await lookup.entered;
  host.importNeedsRestart = false;
  host.busy = false;
  lookup.release();
  await pending;
  assert.deepEqual(host.executeCalls, []);
  assert.equal(host.dialogCount, 0);
});

test('a second click during capability lookup does not start another request', async () => {
  reset();
  const lookup = gate();

  host.onGetCommands = lookup.run;
  const run = action();
  const pending = run();

  await lookup.entered;
  await run();
  assert.equal(host.commandReads, 1);
  lookup.release();
  await pending;
  assert.deepEqual(host.executeCalls, [['workbench.action.quit']]);
  assert.equal(host.dialogCount, 0);
});

test('a second click while the native command is pending is ignored', async () => {
  reset();
  const command = gate();

  host.onExecute = command.run;
  const run = action();
  const pending = run();

  await command.entered;
  await run();
  assert.equal(host.commandReads, 1);
  assert.deepEqual(host.executeCalls, [['workbench.action.quit']]);
  command.release();
  await pending;
  assert.equal(host.dialogCount, 0);
});

test('executeCommand failure preserves the import result and allows retry', async () => {
  reset();
  const run = action();

  host.onExecute = async () => {
    throw new Error('host rejected quit');
  };

  await run();
  assert.equal(host.importNeedsRestart, true);
  assert.match(host.logError[0] || '', /host rejected quit/);
  assert.match(host.errors[0] || '', /Unable to quit Cursor/);
  host.onExecute = undefined;
  await run();
  assert.equal(host.executeCalls.length, 2);
  assert.equal(host.dialogCount, 0);
});

test('capability lookup failure releases the guard for retry', async () => {
  reset();
  const run = action();

  host.onGetCommands = async () => {
    throw new Error('lookup failed');
  };

  await run();
  assert.deepEqual(host.executeCalls, []);
  assert.match(host.logError[0] || '', /lookup failed/);
  host.onGetCommands = undefined;
  await run();
  assert.deepEqual(host.executeCalls, [['workbench.action.quit']]);
});

test('a resolved command is not proof of shutdown; preserve state and allow retry', async () => {
  reset();
  const run = action();

  // A native veto may resolve without a result; it is not an extension failure.
  await run();
  assert.equal(host.importNeedsRestart, true);
  assert.deepEqual(host.info, []);
  assert.deepEqual(host.errors, []);
  await run();
  assert.equal(host.executeCalls.length, 2);
  assert.equal(host.dialogCount, 0);
});

test('stale Quit after export or a no-op import has no side effects', async () => {
  reset();
  host.importNeedsRestart = false;
  await action()();
  assert.equal(host.dialogCount, 0);
  assert.equal(host.commandReads, 0);
  assert.deepEqual(host.executeCalls, []);
  assert.deepEqual(host.info, []);
});

test(
  'undismissed manual-quit and failure notices never block another Quit request',
  { timeout: 3000 },
  async () => {
    reset();
    host.pendingNotices = true;
    const quit = action();

    host.commands = [];
    await quit();
    host.commands = ['workbench.action.quit'];

    host.onExecute = async () => {
      throw new Error('Host refused');
    };

    await quit();
    assert.equal(host.errors.length, 1);
    host.onExecute = undefined;
    await quit();
    assert.equal(host.executeCalls.length, 2);
  },
);
