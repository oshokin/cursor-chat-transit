import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { DeletionJob, ManagedDeleteRequest } from '../src/deletion-types';
import type { ManagedNode } from '../src/managed-node';
import type * as vscode from 'vscode';
import type { TransitLog } from '../src/output-ui';
import type { WorkspaceEntry } from '../src/types';
import type { CatalogueJob, CatalogueUpdate } from '../src/workspace-catalogue';
import type { ManagedSearchItem } from '../src/managed-search';
import type { TransferJob } from '../src/transfer-process';
import type { StatisticsJob, StatisticsUpdate } from '../src/statistics';
import { workspaceStatisticsKey } from '../src/statistics';
import { orderWorkspaceEntries } from '../src/workspace-opening';

/** Drop snapshot-only opening facts before comparing a row with its fixture. */
function withoutOpening(entry: WorkspaceEntry): WorkspaceEntry {
  const copy = { ...entry };

  delete copy.opening;

  return copy;
}

const entries = ['a', 'b'].map(
  (id) =>
    ({
      storageRoot: `/profile-${id}`,
      storageId: 'shared',
      workspaceDbPath: `/${id}/state.vscdb`,
      globalDbPath: `/${id}/global.vscdb`,
      key: 'same',
      mtime: 0,
      identity: {
        kind: 'folder',
        uri: { scheme: 'file', authority: '', path: '/project' },
      },
    }) as WorkspaceEntry,
);

const events: string[] = [];
const deletions: ManagedDeleteRequest[][] = [];
const registeredCommands = new Map<string, (node?: unknown) => Promise<void>>();
const nativeContexts = new Map<string, unknown>();
let registeredManager: import('../src/extension-manager').ChatManager;
let nativeSelection: ManagedNode[] = [];
const jobs: (TransferJob | StatisticsJob | CatalogueJob | DeletionJob)[] = [];
let failRead = false;
let holdIssues: Promise<void> | undefined;

const chatHealth = new Map<
  string,
  'ready' | 'empty' | 'missing' | 'incomplete' | 'unknown' | 'failed'
>();

let listedComposers: import('../src/types').ComposerHeader[] = [
  { composerId: 'chat', name: 'Example' },
];

let catalogueHeaders: import('../src/types').ComposerHeader[] = [
  { composerId: 'found', name: 'Search target' },
];

let hideFirst = false;
let failedFirst = false;
let holdScan: (() => Promise<void>) | undefined;
let holdChats: (() => Promise<void>) | undefined;
let holdCatalogue: (() => Promise<void>) | undefined;
let inventoryError: Error | undefined;
let catalogueFailure: 'none' | 'throw' | 'partial' = 'none';
let emptyHold: Promise<void> | undefined;
let emptyFail = false;

let emptyResult: {
  selected: WorkspaceEntry[];
  unchecked: number;
  candidates: number;
} = { selected: [], unchecked: 0, candidates: 0 };

let lockDepth = 0;

const lockStatuses: Array<{ title: string; detail: string } | undefined> = [];
const ui: Record<string, unknown> = {};

const mockRuntime: { uiState: typeof ui; progressTimer?: NodeJS.Timeout } = {
  uiState: ui,
};

const messages: string[] = [];
let currentDatabase: string | undefined;
let searchPickers: ReturnType<typeof createSearchPicker>[] = [];

function createSearchPicker() {
  const listeners = new Map<string, () => void>();

  const picker = {
    busy: true,
    title: '',
    ignoreFocusOut: false,
    items: [] as Array<ManagedSearchItem & { description?: string }>,
    activeItems: [] as ManagedSearchItem[],
    selectedItems: [] as ManagedSearchItem[],
    onDidAccept: (fn: () => void) => {
      listeners.set('accept', fn);

      return { dispose() {} };
    },
    onDidHide: (fn: () => void) => {
      listeners.set('hide', fn);

      return { dispose() {} };
    },
    show() {},
    dispose() {},
    hide() {
      listeners.get('hide')?.();
    },
    accept(index: number) {
      this.selectedItems = [this.items[index]];
      listeners.get('accept')?.();
    },
  };

  return picker;
}

async function readySearch() {
  for (let i = 0; i < 100; i++) {
    const picker = searchPickers.at(-1);

    if (picker && !picker.busy) return picker;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  throw new Error('Search did not finish loading');
}

const log = {
  info: (s: string) => messages.push(s),
  warn() {},
  error() {},
  appendLine() {},
  show() {},
  dispose() {},
} as TransitLog;

let savedSort: unknown;

const context = {
  globalState: {
    get: (key?: string) =>
      key === 'manageWorkspaceSort' ? savedSort : ['obsolete hidden state'],
    update: (key: string, value: unknown) => {
      if (key !== 'manageWorkspaceSort') assert.fail('No manual hiding writes');
      savedSort = value;
    },
  },
  subscriptions: [],
} as unknown as vscode.ExtensionContext;

const loader = Module as unknown as {
  _load(id: string, parent: unknown, isMain: boolean): unknown;
};

const original = loader._load;

const fake = {
  EventEmitter: class {
    private listeners = new Set<() => void>();
    event = (listener: () => void) => {
      this.listeners.add(listener);

      return { dispose: () => this.listeners.delete(listener) };
    };
    fire() {
      for (const listener of this.listeners) listener();
    }
    dispose() {
      this.listeners.clear();
    }
  },
  TreeItem: class {
    constructor(
      public label: string,
      public collapsibleState: number,
    ) {}
  },
  TreeItemCheckboxState: { Checked: 1, Unchecked: 0 },
  commands: {
    executeCommand: async (_command: string, key: string, value: unknown) => {
      nativeContexts.set(key, value);
    },
    registerCommand: (
      id: string,
      action: (node?: unknown) => Promise<void>,
    ) => {
      registeredCommands.set(id, action);

      return { dispose() {} };
    },
  },
  workspace: { onDidChangeConfiguration: () => ({ dispose() {} }) },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1 },
  ThemeIcon: class {
    constructor(public id: string) {}
  },
  ProgressLocation: { Notification: 15 },
  window: {
    createTreeView: (
      _id: string,
      options: vscode.TreeViewOptions<ManagedNode>,
    ) => {
      registeredManager = options.treeDataProvider as typeof registeredManager;
      assert.equal(options.canSelectMany, false);
      assert.equal(options.manageCheckboxStateManually, true);

      return {
        get selection() {
          return nativeSelection;
        },
        onDidChangeCheckboxState: () => ({ dispose() {} }),
        dispose() {},
      };
    },
    createQuickPick: () => {
      const picker = createSearchPicker();

      searchPickers.push(picker);

      return picker;
    },
    withProgress: async (
      _options: unknown,
      run: (progress: unknown, token: unknown) => Promise<unknown>,
    ) => run({ report() {} }, {}),
    showInformationMessage: async () => {
      events.push('notice');
    },
  },
};

loader._load = function (id, parent, isMain) {
  if (id === 'vscode') return fake;
  if (id === './extension-managed-delete')
    return {
      deleteManagedChats: async (
        _context: unknown,
        _log: unknown,
        targets: ManagedDeleteRequest[],
      ) => {
        deletions.push(targets);

        return false;
      },
    };
  if (id === './extension-state')
    return {
      runtime: mockRuntime,
      setUi: (value: object) => Object.assign(ui, value),
      withLock: async (
        _ctx: unknown,
        run: () => Promise<unknown>,
        status?: { title: string; detail: string },
      ) => {
        lockStatuses.push(status);
        if (lockDepth) return undefined;
        lockDepth += 1;

        try {
          return await run();
        } finally {
          lockDepth -= 1;
        }
      },
      linkedSignal: () => new AbortController().signal,
      finishPhaseProgress() {
        clearInterval(mockRuntime.progressTimer);
      },
      attachPhaseProgress: () => () => {},
    };
  if (id === './extension-workspaces')
    return {
      listHostEntries: () => ({ entries, userDir: '/profile-managed' }),
      listHostEntriesAsync: async () => ({
        entries,
        userDir: '/profile-managed',
        identity: undefined,
      }),
      loadHostEntries: async () => {
        if (inventoryError) throw inventoryError;

        return {
          entries,
          userDir: '/profile-managed',
          identity: undefined,
          incompleteIds: [],
        };
      },
      currentWorkspaceDatabase: () => currentDatabase,
      prepareSqlite: async () => ({ executable: 'sqlite3', initFile: '' }),
    };
  if (id === './extension-settings') return { transferSettings: () => ({}) };
  if (id === './transfer-process')
    return {
      runTransfer: async (
        job: TransferJob | StatisticsJob | CatalogueJob | DeletionJob,
        handlers: {
          signal: AbortSignal;
          onStatistics?: (row: StatisticsUpdate) => void;
          onCatalogue?: (row: CatalogueUpdate) => void;
        },
      ) => {
        jobs.push(job);
        events.push(job.kind);

        if (job.kind === 'workspace-statistics') {
          await holdScan?.();
          handlers.signal.throwIfAborted();

          handlers.onStatistics?.({
            key: workspaceStatisticsKey(entries[0]),
            detail: 'Empty',
            hide: hideFirst,
            failed: failedFirst,
          });

          if (failRead) throw new Error('Database unavailable');

          return { failed: failedFirst ? 1 : 0 };
        }

        if (job.kind === 'find-empty-workspaces') {
          await emptyHold;
          if (emptyFail) throw new Error('scan failed');

          return emptyResult;
        }

        if (failRead) throw new Error('Database unavailable');

        if (job.kind === 'workspace-catalogue') {
          await holdCatalogue?.();
          handlers.signal.throwIfAborted();
          if (catalogueFailure === 'throw') throw new Error('catalogue failed');

          for (let index = 0; index < job.workspaces.length; index++) {
            if (catalogueFailure === 'partial' && index > 0)
              throw new Error('catalogue failed');

            handlers.onCatalogue?.({
              index,
              headers: catalogueHeaders,
            });
          }

          return { failed: 0 };
        }

        if (job.kind === 'list-chats') {
          const headers = listedComposers.slice();

          await holdChats?.();

          return { allComposers: headers };
        }

        if (job.kind === 'chat-statistics') {
          await holdIssues;
          let failed = 0;

          for (const chat of job.chats || []) {
            const mark = chatHealth.get(chat.composerId) || 'missing';

            if (mark === 'failed') {
              failed += 1;

              handlers.onStatistics?.({
                key: chat.composerId,
                detail: 'Check failed',
                failed: true,
              });

              continue;
            }

            handlers.onStatistics?.({
              key: chat.composerId,
              detail: mark,
              health: mark,
            });
          }

          return { failed };
        }

        return { allComposers: listedComposers };
      },
    };

  return original.call(this, id, parent, isMain);
};

let Manager: typeof import('../src/extension-manager').ChatManager;
let registerManager: typeof import('../src/extension-manager').registerManager;

try {
  registerManager = require('../src/extension-manager').registerManager;

  Manager = (
    require('../src/extension-manager') as typeof import('../src/extension-manager')
  ).ChatManager;
} finally {
  loader._load = original;
}

beforeEach(() => {
  events.length = 0;
  deletions.length = 0;
  registeredCommands.clear();
  nativeContexts.clear();
  nativeSelection = [];
  jobs.length = 0;
  messages.length = 0;
  failRead = hideFirst = failedFirst = false;
  holdIssues = undefined;
  chatHealth.clear();
  holdScan = undefined;
  holdChats = undefined;
  holdCatalogue = undefined;
  inventoryError = undefined;
  catalogueFailure = 'none';
  lockStatuses.length = 0;
  currentDatabase = undefined;
  savedSort = undefined;
  searchPickers = [];
  listedComposers = [{ composerId: 'chat', name: 'Example' }];
  catalogueHeaders = [{ composerId: 'found', name: 'Search target' }];
  clearInterval(mockRuntime.progressTimer);
  for (const key of Object.keys(ui)) delete ui[key];
});

test('manager filters once per refresh, caches headers, and distinguishes physical storage', async () => {
  const manager = new Manager(context, log);

  try {
    const [roots, same] = await Promise.all([
      manager.getChildren(),
      manager.getChildren(),
    ]);

    assert.equal(roots, same);
    assert.equal(jobs.length, 1);
    assert.equal(roots.length, 2);

    assert.notEqual(
      manager.getTreeItem(roots[0]).id,
      manager.getTreeItem(roots[1]).id,
    );

    const [a, b] = await Promise.all([
      manager.getChildren(roots[0]),
      manager.getChildren(roots[0]),
    ]);

    assert.equal(a, b);
    assert.equal(jobs.length, 2);

    assert.match(
      String(manager.getTreeItem(a[0]).tooltip),
      /Storage: \/a\/state.vscdb/,
    );

    failRead = true;
    manager.refresh();
    const failed = await manager.getChildren(roots[0]);

    assert.equal(manager.getTreeItem(failed[0]).contextValue, 'unavailable');
  } finally {
    manager.dispose();
  }
});

test('cleanup hides empty roots and toggles unavailable workspaces without a rescan', async () => {
  const manager = new Manager(context, log);

  try {
    hideFirst = true;

    assert.deepEqual(
      (await manager.getChildren()).map((n) => withoutOpening(n.workspace)),
      [entries[1]],
    );

    failedFirst = true;
    manager.refresh();
    assert.equal((await manager.getChildren()).length, 1);
    manager.toggleVisibility();
    assert.equal((await manager.getChildren()).length, 2);
    failRead = true;
    manager.refresh();
    assert.equal((await manager.getChildren()).length, 2);
  } finally {
    manager.dispose();
  }
});

test('refresh aborts an old root scan and never applies its partial filter', async () => {
  let release!: () => void;

  holdScan = () =>
    new Promise((resolve) => {
      release = resolve;
    });

  const manager = new Manager(context, log);

  try {
    const old = manager.getChildren();
    const deadline = Date.now() + 2000;

    while (!release && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 5));

    assert.equal(typeof release, 'function');
    manager.refresh();
    holdScan = undefined;
    release();
    assert.deepEqual(await old, []);
    assert.equal((await manager.getChildren()).length, 2);
  } finally {
    manager.dispose();
  }
});

test('a late chat list cannot replace the catalogue loaded after refresh', async () => {
  let releaseOld: () => void = () => {};
  let enteredOld: () => void = () => {};

  const enteredOldP = new Promise<void>((resolve) => {
    enteredOld = resolve;
  });

  holdChats = () => {
    enteredOld();

    return new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
  };

  listedComposers = [{ composerId: 'old', name: 'Old' }];
  const manager = new Manager(context, log);

  try {
    const roots = await manager.getChildren();
    const oldRead = manager.getChildren(roots[0]);

    await enteredOldP;
    holdChats = undefined;
    listedComposers = [{ composerId: 'new', name: 'New' }];
    manager.refresh();
    const roots2 = await manager.getChildren();
    const fresh = await manager.getChildren(roots2[0]);

    assert.equal(fresh[0]?.chat?.composerId, 'new');
    releaseOld();
    await oldRead;

    assert.equal(
      (await manager.getChildren(roots2[0]))[0]?.chat?.composerId,
      'new',
    );
  } finally {
    releaseOld();
    manager.dispose();
  }
});

test('an inventory error finishes the status and refresh can read again', async () => {
  inventoryError = Object.assign(new Error('EACCES audit metadata read'), {
    code: 'EACCES',
  });

  const seen: string[] = [];
  const manager = new Manager(context, log, (message) => seen.push(message));

  try {
    assert.deepEqual(await manager.getChildren(), []);
    assert.equal(seen.at(-1)?.includes('Preparing'), false);
    assert.match(seen.at(-1) || '', /Refresh to try again/);
    inventoryError = undefined;
    manager.refresh();

    assert.equal((await manager.getChildren()).length, 2);
  } finally {
    manager.dispose();
  }
});

test('clearing check results drops a cached filtered root list', async () => {
  hideFirst = true;
  const manager = new Manager(context, log);

  try {
    assert.equal((await manager.getChildren()).length, 1);
    const visible = await manager.getChildren();

    await manager.select(visible[0], true);
    manager.invalidateCheckResults();

    assert.equal(manager.selection.values().length, 1);
    assert.equal((await manager.getChildren()).length, 2);

    const before = jobs.filter(
      (job) => job.kind === 'workspace-statistics',
    ).length;

    assert.equal((await manager.getChildren()).length, 2);

    assert.equal(
      jobs.filter((job) => job.kind === 'workspace-statistics').length,
      before,
    );

    manager.toggleVisibility();
    manager.toggleVisibility();
    manager.sortWorkspaces('recent');
    assert.equal((await manager.getChildren()).length, 2);
    manager.sortWorkspaces('name');
    assert.equal((await manager.getChildren()).length, 2);
  } finally {
    manager.dispose();
  }
});

test('a failed workspace check is shown again after results are cleared', async () => {
  failedFirst = true;
  const manager = new Manager(context, log);

  try {
    assert.equal((await manager.getChildren()).length, 1);
    manager.invalidateCheckResults();
    assert.equal((await manager.getChildren()).length, 2);
  } finally {
    manager.dispose();
  }
});

test('search does not reread a workspace the tree finished while search waited', async () => {
  let releaseB: () => void = () => {};
  let enteredB: () => void = () => {};

  const enteredBP = new Promise<void>((resolve) => {
    enteredB = resolve;
  });

  let releaseA: () => void = () => {};
  let enteredA: () => void = () => {};

  const enteredAP = new Promise<void>((resolve) => {
    enteredA = resolve;
  });

  let chatCalls = 0;

  holdChats = () => {
    chatCalls += 1;

    if (chatCalls === 1) {
      enteredB();

      return new Promise<void>((resolve) => {
        releaseB = resolve;
      });
    }

    enteredA();

    return new Promise<void>((resolve) => {
      releaseA = resolve;
    });
  };

  const manager = new Manager(context, log);

  try {
    const roots = await manager.getChildren();
    const readingB = manager.getChildren(roots[1]);

    await enteredBP;
    const search = manager.find(async () => {});

    await new Promise<void>((resolve) => setImmediate(resolve));
    const readingA = manager.getChildren(roots[0]);

    await enteredAP;
    releaseA();
    await readingA;
    releaseB();
    await readingB;

    const picker = await readySearch();

    picker.hide();
    await search;

    assert.equal(
      jobs.filter((job) => job.kind === 'workspace-catalogue').length,
      0,
    );

    assert.equal(jobs.filter((job) => job.kind === 'list-chats').length, 2);
  } finally {
    releaseA();
    releaseB();
    manager.dispose();
  }
});

test('closing search releases the picker while the shared catalogue continues', async () => {
  let releaseCatalogue: () => void = () => {};
  let enteredCatalogue: () => void = () => {};

  const enteredCatalogueP = new Promise<void>((resolve) => {
    enteredCatalogue = resolve;
  });

  holdCatalogue = () => {
    enteredCatalogue();

    return new Promise<void>((resolve) => {
      releaseCatalogue = resolve;
    });
  };

  const manager = new Manager(context, log);

  try {
    let settled = false;

    const search = manager
      .find(async () => {})
      .then(() => {
        settled = true;
      });

    await enteredCatalogueP;
    searchPickers.at(-1)?.hide();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, true);

    const reopened = manager.find(async () => {});

    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(searchPickers.length, 2);

    assert.equal(
      jobs.filter((job) => job.kind === 'workspace-catalogue').length,
      1,
    );

    searchPickers.at(-1)?.hide();
    releaseCatalogue();
    await search;
    await reopened;
  } finally {
    releaseCatalogue();
    manager.dispose();
  }
});

test('accepting a loaded search row does not wait for the rest of the catalogue', async () => {
  const manager = new Manager(context, log);

  try {
    const roots = await manager.getChildren();

    await manager.getChildren(roots[0]);
    let releaseCatalogue: () => void = () => {};
    let enteredCatalogue: () => void = () => {};

    const enteredCatalogueP = new Promise<void>((resolve) => {
      enteredCatalogue = resolve;
    });

    holdCatalogue = () => {
      enteredCatalogue();

      return new Promise<void>((resolve) => {
        releaseCatalogue = resolve;
      });
    };

    let revealed = false;

    const search = manager.find(async () => {
      revealed = true;
    });

    await enteredCatalogueP;
    const picker = searchPickers.at(-1);
    const index = picker?.items.findIndex((row) => row.node.chat) ?? -1;

    assert.equal(index >= 0, true);
    picker?.accept(index);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(revealed, true);
    releaseCatalogue();
    await search;
  } finally {
    manager.dispose();
  }
});

test('a catalogue failure settles every joined tree read', async () => {
  catalogueFailure = 'partial';
  let releaseCatalogue: () => void = () => {};
  let enteredCatalogue: () => void = () => {};

  const enteredCatalogueP = new Promise<void>((resolve) => {
    enteredCatalogue = resolve;
  });

  holdCatalogue = () => {
    enteredCatalogue();

    return new Promise<void>((resolve) => {
      releaseCatalogue = resolve;
    });
  };

  const manager = new Manager(context, log);

  try {
    const search = manager.find(async () => {});

    await enteredCatalogueP;
    const roots = await manager.getChildren();
    const left = manager.getChildren(roots[0]);
    const right = manager.getChildren(roots[1]);

    manager.refresh();
    releaseCatalogue();
    await left;
    await right;
    const roots2 = await manager.getChildren();

    assert.equal(
      (await manager.getChildren(roots2[0]))[0]?.chat?.composerId,
      'chat',
    );

    assert.equal(
      jobs.filter((job) => job.kind === 'list-chats').length >= 1,
      true,
    );

    searchPickers.at(-1)?.hide();
    await search;
  } finally {
    releaseCatalogue();
    manager.dispose();
  }
});

test('search and tree share one catalogue read', async () => {
  let releaseCatalogue: () => void = () => {};
  let enteredCatalogue: () => void = () => {};

  const enteredCatalogueP = new Promise<void>((resolve) => {
    enteredCatalogue = resolve;
  });

  holdCatalogue = () => {
    enteredCatalogue();

    return new Promise<void>((resolve) => {
      releaseCatalogue = resolve;
    });
  };

  const manager = new Manager(context, log);

  try {
    const search = manager.find(async () => {});

    await enteredCatalogueP;
    const roots = await manager.getChildren();
    const children = manager.getChildren(roots[0]);

    releaseCatalogue();

    assert.equal((await children)[0]?.chat?.composerId, 'found');

    assert.equal(jobs.filter((job) => job.kind === 'list-chats').length, 0);

    const picker = await readySearch();

    picker.hide();
    await search;
  } finally {
    releaseCatalogue();
    manager.dispose();
  }
});

test('manager lists workspaces by name instead of pinning the current window', async () => {
  currentDatabase = entries[1].workspaceDbPath;
  const manager = new Manager(context, log);

  try {
    assert.deepEqual(
      (await manager.getChildren()).map((n) => withoutOpening(n.workspace)),
      [entries[0], entries[1]],
    );
  } finally {
    manager.dispose();
  }
});

test('one search covers collapsed workspaces, reuses headers, and reveals an actual tree parent', async () => {
  const manager = new Manager(context, log);
  const revealed: import('../src/managed-node').ManagedNode[] = [];

  const reveal = async (node: import('../src/managed-node').ManagedNode) => {
    revealed.push(node);
  };

  try {
    const first = manager.find(reveal);
    const concurrent = manager.find(reveal);
    const picker = await readySearch();

    assert.equal(searchPickers.length, 1);
    assert.equal(picker.items.filter((row) => row.node.chat).length, 2);

    assert.equal(
      jobs.filter((job) => job.kind === 'workspace-catalogue').length,
      1,
    );

    picker.accept(1);
    await Promise.all([first, concurrent]);
    assert.equal(revealed.length, 1);
    const roots = await manager.getChildren();

    assert.equal(await manager.getParent(revealed[0]), roots[0]);

    assert.equal(
      (await manager.getChildren(roots[0]))[0].chat?.composerId,
      'found',
    );

    const repeat = manager.find(reveal);
    const second = await readySearch();

    second.hide();
    await repeat;

    assert.equal(
      jobs.filter((job) => job.kind === 'workspace-catalogue').length,
      1,
    );

    assert.equal(jobs.filter((job) => job.kind === 'list-chats').length, 0);
  } finally {
    manager.dispose();
  }
});

test('search then tree keeps one parent root for a nested family', async () => {
  catalogueHeaders = familyHeaders;
  const manager = new Manager(context, log);

  try {
    const search = manager.find(async () => {});
    const picker = await readySearch();

    const ids = picker.items
      .filter(
        (row) =>
          row.node.chat &&
          row.node.workspace.storageRoot === entries[0].storageRoot,
      )
      .map((row) => row.node.chat?.composerId)
      .sort();

    assert.deepEqual(ids, ['child', 'grand', 'parent']);
    picker.hide();
    await search;
    const roots = await manager.getChildren();
    const top = await manager.getChildren(roots[0]);

    assert.deepEqual(
      top.map((node) => node.chat?.composerId),
      ['parent'],
    );

    const children = await manager.getChildren(top[0]);

    assert.deepEqual(
      children.map((node) => node.chat?.composerId),
      ['child'],
    );
  } finally {
    manager.dispose();
  }
});

test('tree then search still finds nested chats', async () => {
  listedComposers = familyHeaders;
  const manager = new Manager(context, log);

  try {
    const roots = await manager.getChildren();
    const top = await manager.getChildren(roots[0]);

    assert.deepEqual(
      top.map((node) => node.chat?.composerId),
      ['parent'],
    );

    const search = manager.find(async () => {});
    const picker = await readySearch();

    const ids = picker.items
      .filter(
        (row) =>
          row.node.chat &&
          row.node.workspace.workspaceDbPath ===
            roots[0].workspace.workspaceDbPath,
      )
      .map((row) => row.node.chat?.composerId)
      .sort();

    assert.deepEqual(ids, ['child', 'grand', 'parent']);
    picker.hide();
    await search;
  } finally {
    manager.dispose();
  }
});

test('search retries failed tree reads and ignores selected results invalidated by refresh', async () => {
  const manager = new Manager(context, log);

  try {
    failRead = true;
    await manager.getChildren({ workspace: entries[0] });
    failRead = false;

    const search = manager.find(async () =>
      assert.fail('Stale search must not reveal a row'),
    );

    const picker = await readySearch();

    assert.equal(picker.items.filter((row) => row.node.chat).length, 2);
    manager.refresh();
    picker.accept(1);
    await search;
  } finally {
    manager.dispose();
  }
});

test('checkboxes retain selections across focus and filters, but refresh clears them', async () => {
  const manager = new Manager(context, log);

  try {
    const roots = await manager.getChildren();

    await manager.select(roots[0], true);
    const chat = (await manager.getChildren(roots[0]))[0];

    assert.equal(
      manager.getTreeItem(chat).checkboxState,
      fake.TreeItemCheckboxState.Checked,
    );

    manager.toggleVisibility();
    assert.equal(manager.selection.values().length, 1);
    manager.refresh();
    assert.equal(manager.selection.values().length, 0);
  } finally {
    manager.dispose();
  }
});

test('unchecking a child keeps selected siblings in the same physical workspace', async () => {
  const manager = new Manager(context, log);

  try {
    const roots = await manager.getChildren();

    // Install a resolved read result exactly as an expanded tree would.
    const children = [
      { workspace: roots[0].workspace, chat: { composerId: 'first' } },
      { workspace: roots[0].workspace, chat: { composerId: 'second' } },
    ];

    (
      manager as unknown as { lists: Map<string, Promise<typeof children>> }
    ).lists.set(
      workspaceStatisticsKey(roots[0].workspace),
      Promise.resolve(children),
    );

    await manager.select(roots[0], true);
    await manager.select(children[0], false);
    assert.equal(manager.selection.has(children[0]), false);
    assert.equal(manager.selection.has(children[1]), true);
    assert.equal(manager.selection.has(roots[0]), false);
    assert.deepEqual(manager.selection.values(), [children[1]]);
    manager.clearSelection();
    assert.equal(manager.selection.values().length, 0);
  } finally {
    manager.dispose();
  }
});

test('select all uses only visible workspaces and clear also removes hidden selections', async () => {
  hideFirst = true;
  const manager = new Manager(context, log);

  try {
    await manager.selectAll();

    assert.deepEqual(
      manager.selection.values().map((node) => withoutOpening(node.workspace)),
      [entries[1]],
    );

    manager.toggleVisibility();
    await manager.selectAll();
    assert.equal(manager.selection.values().length, 2);
    manager.toggleVisibility();
    manager.clearSelection();
    assert.equal(manager.selection.values().length, 0);
  } finally {
    manager.dispose();
  }
});

test('row deletion uses all checked chats, including another storage, without adding the clicked row', async () => {
  const manager = new Manager(context, log);
  const a = { workspace: entries[0], chat: { composerId: 'a' } };
  const b = { workspace: entries[1], chat: { composerId: 'b' } };
  const other = { workspace: entries[0], chat: { composerId: 'unchecked' } };

  try {
    await manager.select(a, true);
    await manager.select(b, true);
    await manager.deleteSelected(a);
    await manager.deleteSelected(other);
    await manager.deleteSelected();

    const expected = [
      { kind: 'chats' as const, workspace: entries[0], ids: ['a'] },
      { kind: 'chats' as const, workspace: entries[1], ids: ['b'] },
    ];

    assert.deepEqual(deletions, [expected, expected, expected]);
    // Cancelling/no writes keeps the explicit selection available for retry.
    assert.deepEqual(manager.selection.values(), [a, b]);
  } finally {
    manager.dispose();
  }
});

test('checked workspace covers every child and a clicked child cannot narrow deletion', async () => {
  const manager = new Manager(context, log);
  const root = { workspace: entries[0] };
  const clicked = { workspace: entries[0], chat: { composerId: 'chat' } };

  try {
    const sibling = { workspace: entries[0], chat: { composerId: 'sibling' } };

    (
      manager as unknown as { lists: Map<string, Promise<ManagedNode[]>> }
    ).lists.set(
      workspaceStatisticsKey(entries[0]),
      Promise.resolve([clicked, sibling]),
    );

    await manager.select(clicked, true);
    await manager.select(root, true);
    await manager.deleteSelected(clicked);

    assert.deepEqual(deletions, [
      [{ kind: 'workspace-data', workspace: entries[0] }],
    ]);

    assert.equal(jobs.filter((job) => job.kind === 'list-chats').length, 0);
  } finally {
    manager.dispose();
  }
});

test('hidden checked workspace stays a workspace-data request and is not expanded into chat ids', async () => {
  const manager = new Manager(context, log);

  try {
    hideFirst = true;
    const hidden = { workspace: entries[0] };
    const visible = { workspace: entries[1], chat: { composerId: 'visible' } };

    await manager.select(hidden, true);
    await manager.select(visible, true);
    assert.equal((await manager.getChildren()).length, 1);
    failRead = true;
    await manager.deleteSelected(visible);

    assert.deepEqual(deletions, [
      [
        { kind: 'workspace-data', workspace: entries[0] },
        { kind: 'chats', workspace: entries[1], ids: ['visible'] },
      ],
    ]);

    assert.equal(manager.selection.values().length, 2);
  } finally {
    manager.dispose();
  }
});

test('row deletion falls back to that row only with no checked items; empty toolbar has no fallback', async () => {
  const manager = new Manager(context, log);
  const row = { workspace: entries[0], chat: { composerId: 'only' } };

  try {
    await manager.deleteSelected(row);
    await manager.deleteSelected();

    assert.deepEqual(deletions, [
      [{ kind: 'chats', workspace: entries[0], ids: ['only'] }],
      [],
    ]);
  } finally {
    manager.dispose();
  }
});

test('registered toolbar command ignores native context and focus; row command rechecks checkbox scope', async () => {
  const ownContext = {
    ...context,
    subscriptions: [],
  } as unknown as vscode.ExtensionContext;

  registerManager(ownContext, log);
  const a = { workspace: entries[0], chat: { composerId: 'a' } };
  const b = { workspace: entries[0], chat: { composerId: 'b' } };
  const focused = { workspace: entries[1], chat: { composerId: 'focused' } };
  const bulk = registeredCommands.get('cursorChatTransit.manageDelete')!;
  const row = registeredCommands.get('cursorChatTransit.manageDeleteItem')!;

  try {
    assert.equal(
      nativeContexts.get('cursorChatTransit.manageHasCheckedItems'),
      false,
    );

    nativeSelection = [focused];
    await bulk(focused);
    await bulk({ viewId: 'cursorChatTransit.manage' });
    assert.deepEqual(deletions, [[], []]);
    await registeredManager.select(a, true);
    await registeredManager.select(b, true);

    assert.equal(
      nativeContexts.get('cursorChatTransit.manageHasCheckedItems'),
      true,
    );

    await bulk(focused);
    // A menu that was created before a checkbox change must not use stale scope.
    await row(focused);

    const checked = [
      { kind: 'chats' as const, workspace: entries[0], ids: ['a', 'b'] },
    ];

    assert.deepEqual(deletions.slice(2), [checked, checked]);
    registeredManager.clearSelection();

    assert.equal(
      nativeContexts.get('cursorChatTransit.manageHasCheckedItems'),
      false,
    );

    await row(focused);

    assert.deepEqual(deletions.at(-1), [
      { kind: 'chats', workspace: entries[1], ids: ['focused'] },
    ]);

    await registeredManager.select(a, true);
    registeredManager.refresh();

    assert.equal(
      nativeContexts.get('cursorChatTransit.manageHasCheckedItems'),
      false,
    );
  } finally {
    for (const disposable of ownContext.subscriptions) disposable.dispose();
  }
});

test('manifest exposes one row trash action per checkbox state and keeps toolbar bulk-only', () => {
  const manifest = JSON.parse(
    readFileSync(path.join(__dirname, '../package.json'), 'utf8'),
  );

  const menus = manifest.contributes.menus;

  const rowDelete = menus['view/item/context'].filter(
    (item: { command: string }) => item.command.includes('manageDelete'),
  );

  assert.equal(rowDelete.length, 3);
  assert.equal(rowDelete[0].command, 'cursorChatTransit.manageDelete');

  assert.match(
    rowDelete[0].when,
    /&& cursorChatTransit.manageHasCheckedItems$/,
  );

  assert.equal(rowDelete[1].command, 'cursorChatTransit.manageDeleteItem');

  assert.equal(
    rowDelete[2].command,
    'cursorChatTransit.manageDeleteWorkspaceData',
  );

  assert.match(
    rowDelete[1].when,
    /&& !cursorChatTransit.manageHasCheckedItems$/,
  );

  assert.match(rowDelete[2].when, /managedWorkspace/);
  assert.doesNotMatch(rowDelete[2].when, /managedCurrentWorkspace/);
  assert.equal(rowDelete[0].group, rowDelete[1].group);
  assert.equal(rowDelete[1].group, rowDelete[2].group);

  assert.deepEqual(
    menus['view/title']
      .filter((item: { command: string }) =>
        item.command.includes('manageDelete'),
      )
      .map((item: { command: string }) => item.command),
    ['cursorChatTransit.manageDelete'],
  );
});

test('select empty replaces checks, ignores a late scan, and does not start twice', async () => {
  const lines: string[] = [];

  const manager = new Manager(context, log, (message) => lines.push(message));

  try {
    await manager.select({ workspace: entries[0] }, true);
    emptyResult = { selected: [entries[1]], unchecked: 2, candidates: 1 };
    const selected = await manager.selectEmpty();

    assert.equal(
      selected?.workspace.workspaceDbPath,
      entries[1].workspaceDbPath,
    );

    assert.equal(manager.selection.values().length, 1);
    assert.equal(manager.selection.values()[0]?.requireEmpty, true);

    assert.match(
      lines.at(-1) || '',
      /1 workspace with no chat history selected/,
    );

    assert.match(lines.at(-1) || '', /2 could not be checked/);

    emptyResult = { selected: [], unchecked: 0, candidates: 0 };
    assert.equal(await manager.selectEmpty(), undefined);
    assert.equal(manager.selection.values()[0]?.requireEmpty, true);
    assert.match(lines.at(-1) || '', /Selection unchanged/);

    let release = () => {};

    emptyHold = new Promise<void>((resolve) => {
      release = resolve;
    });

    emptyResult = { selected: [entries[0]], unchecked: 0, candidates: 1 };

    const before = jobs.filter(
      (job) => job.kind === 'find-empty-workspaces',
    ).length;

    const pending = manager.selectEmpty();

    for (
      let i = 0;
      i < 50 &&
      jobs.filter((job) => job.kind === 'find-empty-workspaces').length ===
        before;
      i++
    )
      await new Promise<void>((resolve) => setImmediate(resolve));

    const overlapped = manager.selectEmpty();

    assert.equal(await overlapped, undefined);
    await manager.select({ workspace: entries[1] }, true);
    release();
    emptyHold = undefined;
    assert.equal(await pending, undefined);

    assert.equal(
      manager.selection.values()[0]?.workspace.workspaceDbPath,
      entries[1].workspaceDbPath,
    );

    assert.equal(manager.selection.values()[0]?.requireEmpty, undefined);
    assert.match(lines.at(-1) || '', /Selection changed while checking/);

    assert.equal(
      jobs.filter((job) => job.kind === 'find-empty-workspaces').length,
      before + 1,
    );
  } finally {
    emptyHold = undefined;
    emptyResult = { selected: [], unchecked: 0, candidates: 0 };
    manager.dispose();
  }
});

test('a failed empty scan keeps the previous selection', async () => {
  const manager = new Manager(context, log, () => undefined);

  try {
    await manager.select({ workspace: entries[0] }, true);
    emptyFail = true;
    await assert.rejects(manager.selectEmpty(), /scan failed/);

    assert.equal(
      manager.selection.values()[0]?.workspace.workspaceDbPath,
      entries[0].workspaceDbPath,
    );

    assert.equal(manager.selection.values()[0]?.requireEmpty, undefined);
  } finally {
    emptyFail = false;
    manager.dispose();
  }
});

test('refresh during an empty scan drops the late result and the eye toggle keeps requireEmpty', async () => {
  const lines: string[] = [];

  const manager = new Manager(context, log, (message) => lines.push(message));

  try {
    manager.selection.selectWorkspaces([
      { workspace: entries[0], requireEmpty: true },
    ]);

    manager.toggleVisibility();
    assert.equal(manager.selection.values()[0]?.requireEmpty, true);
    manager.clearSelection();
    assert.equal(manager.selection.values().length, 0);

    let release = () => {};

    emptyHold = new Promise<void>((resolve) => {
      release = resolve;
    });

    emptyResult = { selected: [entries[1]], unchecked: 0, candidates: 1 };
    const pending = manager.selectEmpty();

    for (
      let i = 0;
      i < 50 && !jobs.some((job) => job.kind === 'find-empty-workspaces');
      i++
    )
      await new Promise<void>((resolve) => setImmediate(resolve));

    manager.refresh();
    release();
    emptyHold = undefined;
    assert.equal(await pending, undefined);
    assert.equal(manager.selection.values().length, 0);
    assert.match(lines.at(-1) || '', /Selection changed while checking/);
  } finally {
    emptyHold = undefined;
    emptyResult = { selected: [], unchecked: 0, candidates: 0 };
    manager.dispose();
  }
});

test('select empty reveals a hidden empty root by turning show-all on', async () => {
  hideFirst = true;
  const manager = new Manager(context, log);

  try {
    assert.equal((await manager.getChildren()).length, 1);
    emptyResult = { selected: [entries[0]], unchecked: 1, candidates: 1 };
    await manager.selectEmpty();
    const roots = await manager.getChildren();

    assert.equal(roots.length, 2);
    assert.equal(manager.selection.values()[0]?.requireEmpty, true);

    assert.equal(
      manager.selection.values()[0]?.workspace.workspaceDbPath,
      entries[0].workspaceDbPath,
    );
  } finally {
    hideFirst = false;
    emptyResult = { selected: [], unchecked: 0, candidates: 0 };
    manager.dispose();
  }
});

test('expanding the tree during an empty scan does not cancel it', async () => {
  const lines: string[] = [];

  const manager = new Manager(context, log, (message) => lines.push(message));

  try {
    let release = () => {};

    emptyHold = new Promise<void>((resolve) => {
      release = resolve;
    });

    emptyResult = { selected: [entries[1]], unchecked: 0, candidates: 1 };
    const pending = manager.selectEmpty();

    for (
      let i = 0;
      i < 50 && !jobs.some((job) => job.kind === 'find-empty-workspaces');
      i++
    )
      await new Promise<void>((resolve) => setImmediate(resolve));

    const roots = await manager.getChildren();

    await manager.getChildren(roots[0]);
    release();
    emptyHold = undefined;

    const selected = await pending;

    assert.equal(
      selected?.workspace.workspaceDbPath,
      entries[1].workspaceDbPath,
    );

    assert.equal(manager.selection.values()[0]?.requireEmpty, true);

    assert.match(
      lines.at(-1) || '',
      /1 workspace with no chat history selected/,
    );
  } finally {
    emptyHold = undefined;
    emptyResult = { selected: [], unchecked: 0, candidates: 0 };
    manager.dispose();
  }
});

test('select empty labels the sidebar as a scan and skips the unchecked note when every workspace was read', async () => {
  const lines: string[] = [];

  const manager = new Manager(context, log, (message) => lines.push(message));

  try {
    emptyResult = { selected: [entries[1]], unchecked: 0, candidates: 1 };
    await manager.selectEmpty();

    assert.deepEqual(lockStatuses.at(-1), {
      title: 'Finding empty workspaces…',
      detail: 'Checking workspaces for chat history.',
    });

    assert.notEqual(lockStatuses.at(-1)?.title, 'Preparing transfer…');

    assert.match(
      lines.at(-1) || '',
      /^1 workspace with no chat history selected\.$/,
    );

    assert.doesNotMatch(lines.at(-1) || '', /could not be checked/);
  } finally {
    emptyResult = { selected: [], unchecked: 0, candidates: 0 };
    manager.dispose();
  }
});

test('cancel deletion keeps uncached chat lists usable', async () => {
  const manager = new Manager(context, log);

  try {
    const roots = await manager.getChildren();

    await manager.deleteSelected(roots[0]);

    const children = await manager.getChildren(roots[0]);

    assert.ok(
      children.some((node) => node.chat),
      JSON.stringify(
        children.map((node) => node.error || node.chat?.composerId),
      ),
    );
  } finally {
    manager.dispose();
  }
});

const familyHeaders = [
  {
    composerId: 'parent',
    name: 'Parent',
    subagentComposerIds: ['child'],
  },
  {
    composerId: 'child',
    name: 'Child',
    isSubagent: true,
    subagentInfo: {
      parentComposerId: 'parent',
      rootParentConversationId: 'parent',
    },
    subagentComposerIds: ['grand'],
  },
  {
    composerId: 'grand',
    name: 'Grand',
    isSubagent: true,
    subagentInfo: {
      parentComposerId: 'child',
      rootParentConversationId: 'parent',
    },
  },
];

test('inline parent check includes confirmed descendants', async () => {
  listedComposers = familyHeaders;
  const manager = new Manager(context, log);

  try {
    const roots = await manager.getChildren();
    const [parent] = await manager.getChildren(roots[0]);

    await manager.select(parent, true);
    assert.equal(manager.selection.values().length, 3);
    await manager.check(parent);

    const job = [...jobs]
      .reverse()
      .find((item) => item.kind === 'chat-statistics');

    assert.ok(job && job.kind === 'chat-statistics');

    assert.deepEqual(job.chats?.map((chat) => chat.composerId).sort(), [
      'child',
      'grand',
      'parent',
    ]);
  } finally {
    manager.dispose();
  }
});

test('name order prefers a newer workspace and a local workspace', () => {
  const older = { ...entries[0], mtime: 1000 };
  const newer = { ...entries[1], mtime: 2000 };

  const named = orderWorkspaceEntries([older, newer], { mode: 'name' });

  assert.equal(named[0].workspaceDbPath, newer.workspaceDbPath);

  const local = {
    ...entries[0],
    identity: {
      kind: 'folder' as const,
      uri: { scheme: 'file', authority: '', path: '/z/project' },
    },
  };

  const ssh = {
    ...entries[1],
    identity: {
      kind: 'folder' as const,
      uri: {
        scheme: 'vscode-remote',
        authority: 'ssh-remote+host',
        path: '/a/project',
      },
    },
  };

  const located = orderWorkspaceEntries([ssh, local], { mode: 'name' });

  assert.equal(located[0].identity?.uri.scheme, 'file');
});

test('sort picker keeps the current mode until accept and does not rescan', async () => {
  const manager = new Manager(context, log);

  try {
    const roots = await manager.getChildren();

    await manager.select(roots[1], true);
    const jobsBefore = jobs.length;

    const checked = manager.selection
      .values()
      .map((node) => node.workspace.workspaceDbPath);

    const dismissed = manager.chooseWorkspaceSort();

    await new Promise((resolve) => setImmediate(resolve));
    const picker = searchPickers.at(-1);

    assert.ok(picker);
    assert.equal(picker.ignoreFocusOut, true);
    assert.equal(picker.items[0]?.description, 'A–Z · Current');
    assert.equal(picker.items[1]?.description, 'Most recent first');
    picker.hide();
    await dismissed;
    assert.equal(savedSort, undefined);

    assert.deepEqual(
      manager.selection.values().map((node) => node.workspace.workspaceDbPath),
      checked,
    );

    const applied = manager.chooseWorkspaceSort();

    await new Promise((resolve) => setImmediate(resolve));
    searchPickers.at(-1)?.accept(1);
    await applied;
    assert.equal(savedSort, 'recent');
    assert.equal(jobs.length, jobsBefore);
    assert.equal(lockStatuses.length, 0);

    assert.deepEqual(
      manager.selection.values().map((node) => node.workspace.workspaceDbPath),
      checked,
    );
  } finally {
    manager.dispose();
  }
});

test('a statistics detail does not replace the storage mark', async () => {
  const manager = new Manager(context, log);

  try {
    const roots = await manager.getChildren();

    roots[0].workspace.opening = {
      expectedId: roots[0].workspace.storageId,
      duplicate: true,
    };

    const description = String(manager.getTreeItem(roots[0]).description);

    assert.match(description, /^Opens with this folder · /);
    assert.match(description, /Empty/);
  } finally {
    manager.dispose();
  }
});

test('selecting transfer issues finishes the Operations status', async () => {
  listedComposers = familyHeaders;
  const manager = new Manager(context, log);

  try {
    await manager.selectIssues();
    assert.ok(manager.selection.values().length > 0);
    assert.notEqual(ui.status, 'running');
  } finally {
    manager.dispose();
  }
});

const issueFamily = [
  {
    composerId: 'ack',
    name: 'Ack/policy changes in NATS',
    subagentComposerIds: ['child', 'sibling'],
  },
  {
    composerId: 'child',
    name: 'Child',
    isSubagent: true,
    subagentInfo: {
      parentComposerId: 'ack',
      rootParentConversationId: 'ack',
    },
    subagentComposerIds: ['grand'],
  },
  {
    composerId: 'grand',
    name: 'Grand',
    isSubagent: true,
    subagentInfo: {
      parentComposerId: 'child',
      rootParentConversationId: 'ack',
    },
  },
  {
    composerId: 'sibling',
    name: 'Sibling',
    isSubagent: true,
    subagentInfo: {
      parentComposerId: 'ack',
      rootParentConversationId: 'ack',
    },
  },
  { composerId: 'other', name: 'Other conversation' },
  {
    composerId: 'orphan',
    name: 'Detached',
    isSubagent: true,
    subagentInfo: { parentComposerId: 'gone' },
  },
];

function composerIds(
  manager: InstanceType<typeof Manager>,
  workspace = entries[0],
): string[] {
  return manager.selection
    .values()
    .filter(
      (node) => node.workspace.workspaceDbPath === workspace.workspaceDbPath,
    )
    .map((node) => node.chat?.composerId)
    .filter((id): id is string => !!id)
    .sort();
}

async function selectIssueFamily(
  health: Record<
    string,
    'ready' | 'empty' | 'missing' | 'incomplete' | 'unknown' | 'failed'
  >,
  lines?: string[],
) {
  listedComposers = issueFamily;

  for (const [id, mark] of Object.entries(health)) chatHealth.set(id, mark);

  const manager = new Manager(context, log, (message) => lines?.push(message));

  await manager.selectIssues();

  return manager;
}

test('an empty parent selects its child and grandchild, not another conversation', async () => {
  const lines: string[] = [];

  const manager = await selectIssueFamily(
    {
      ack: 'empty',
      child: 'ready',
      grand: 'ready',
      sibling: 'ready',
      other: 'ready',
      orphan: 'ready',
    },
    lines,
  );

  try {
    assert.deepEqual(composerIds(manager), [
      'ack',
      'child',
      'grand',
      'sibling',
    ]);

    assert.deepEqual(composerIds(manager, entries[1]), [
      'ack',
      'child',
      'grand',
      'sibling',
    ]);

    assert.equal(
      manager.selection.values().every((node) => node.chat),
      true,
    );

    assert.match(
      lines.at(-1) || '',
      /2 chats selected: 2 empty\. 6 subagents included with a selected parent\./,
    );

    assert.equal(ui.status, 'completed');

    const roots = await manager.getChildren();
    const top = await manager.getChildren(roots[0]);
    const ack = top.find((node) => node.chat?.composerId === 'ack');
    const item = manager.getTreeItem(ack!);

    assert.equal(String(item.description).includes(' of '), false);
    await manager.deleteSelected();

    const request = deletions
      .at(-1)
      ?.find(
        (row) => row.workspace.workspaceDbPath === entries[0].workspaceDbPath,
      );

    assert.equal(request?.kind, 'chats');

    assert.deepEqual([...(request?.ids || [])].sort(), [
      'ack',
      'child',
      'grand',
      'sibling',
    ]);
  } finally {
    manager.dispose();
  }
});

test('a ready parent stays unselected when only its child is empty', async () => {
  const manager = await selectIssueFamily({
    ack: 'ready',
    child: 'empty',
    grand: 'ready',
    sibling: 'ready',
    other: 'ready',
    orphan: 'ready',
  });

  try {
    assert.deepEqual(composerIds(manager), ['child', 'grand']);
    await manager.deleteSelected();

    const request = deletions
      .at(-1)
      ?.find(
        (row) => row.workspace.workspaceDbPath === entries[0].workspaceDbPath,
      );

    assert.equal(request?.kind, 'chats');

    assert.deepEqual([...(request?.ids || [])].sort(), ['child', 'grand']);
  } finally {
    manager.dispose();
  }
});

test('an empty middle chat selects its grandchild and not its parent or sibling', async () => {
  const manager = await selectIssueFamily({
    ack: 'ready',
    child: 'incomplete',
    grand: 'ready',
    sibling: 'ready',
    other: 'ready',
    orphan: 'ready',
  });

  try {
    assert.deepEqual(composerIds(manager), ['child', 'grand']);
  } finally {
    manager.dispose();
  }
});

test('a missing child selects its own descendants and leaves the ready parent', async () => {
  const manager = await selectIssueFamily({
    ack: 'ready',
    child: 'missing',
    grand: 'ready',
    sibling: 'missing',
    other: 'ready',
    orphan: 'ready',
  });

  try {
    assert.deepEqual(composerIds(manager), ['child', 'grand', 'sibling']);
  } finally {
    manager.dispose();
  }
});

test('issue counts ignore descendants that were added only to keep the family', async () => {
  const lines: string[] = [];

  const manager = await selectIssueFamily(
    {
      ack: 'empty',
      child: 'empty',
      grand: 'ready',
      sibling: 'incomplete',
      other: 'ready',
      orphan: 'ready',
    },
    lines,
  );

  try {
    assert.deepEqual(composerIds(manager), [
      'ack',
      'child',
      'grand',
      'sibling',
    ]);

    assert.match(
      lines.at(-1) || '',
      /6 chats selected: 2 incomplete, 4 empty\. 2 subagents included with a selected parent\./,
    );
  } finally {
    manager.dispose();
  }
});

test('a failed or unknown descendant of an empty parent is still selected', async () => {
  const lines: string[] = [];

  const manager = await selectIssueFamily(
    {
      ack: 'empty',
      child: 'failed',
      grand: 'unknown',
      sibling: 'ready',
      other: 'ready',
      orphan: 'ready',
    },
    lines,
  );

  try {
    assert.deepEqual(composerIds(manager), [
      'ack',
      'child',
      'grand',
      'sibling',
    ]);

    assert.match(lines.at(-1) || '', /could not be checked/);
  } finally {
    manager.dispose();
  }
});

test('an unresolved empty chat is selected without inventing its missing parent', async () => {
  const lines: string[] = [];

  const manager = await selectIssueFamily(
    {
      ack: 'ready',
      child: 'ready',
      grand: 'ready',
      sibling: 'ready',
      other: 'ready',
      orphan: 'empty',
    },
    lines,
  );

  try {
    assert.deepEqual(composerIds(manager), ['orphan']);
    assert.equal(composerIds(manager).includes('gone'), false);
    assert.match(lines.at(-1) || '', /^2 chats selected: 2 empty\.$/);
  } finally {
    manager.dispose();
  }
});

test('a leaf with no subagents does not mention included subagents', async () => {
  const lines: string[] = [];

  const manager = await selectIssueFamily(
    {
      ack: 'ready',
      child: 'ready',
      grand: 'ready',
      sibling: 'ready',
      other: 'incomplete',
      orphan: 'ready',
    },
    lines,
  );

  try {
    assert.deepEqual(composerIds(manager), ['other']);
    assert.equal((lines.at(-1) || '').includes('subagent'), false);
    assert.match(lines.at(-1) || '', /2 chats selected: 2 incomplete\./);
  } finally {
    manager.dispose();
  }
});

test('refresh during issue selection does not apply the family afterwards', async () => {
  listedComposers = issueFamily;
  chatHealth.set('ack', 'empty');
  let release = () => {};

  holdIssues = new Promise<void>((resolve) => {
    release = resolve;
  });

  const manager = new Manager(context, log);

  try {
    const pending = manager.selectIssues();

    for (
      let attempt = 0;
      attempt < 50 && !jobs.some((job) => job.kind === 'chat-statistics');
      attempt += 1
    )
      await new Promise<void>((resolve) => setImmediate(resolve));

    manager.refresh();
    release();
    await pending;
    assert.equal(manager.selection.values().length, 0);
    assert.notEqual(ui.status, 'running');
  } finally {
    release();
    manager.dispose();
  }
});

test('a selection edit during the issue scan wins over the family result', async () => {
  listedComposers = issueFamily;
  chatHealth.set('ack', 'empty');
  chatHealth.set('child', 'ready');
  let release = () => {};

  holdIssues = new Promise<void>((resolve) => {
    release = resolve;
  });

  const manager = new Manager(context, log);

  try {
    const pending = manager.selectIssues();

    for (
      let attempt = 0;
      attempt < 50 && !jobs.some((job) => job.kind === 'chat-statistics');
      attempt += 1
    )
      await new Promise<void>((resolve) => setImmediate(resolve));

    const roots = await manager.getChildren();
    const top = await manager.getChildren(roots[0]);
    const other = top.find((node) => node.chat?.composerId === 'other');

    await manager.select(other!, true);
    release();
    await pending;
    assert.deepEqual(composerIds(manager), ['other']);
  } finally {
    release();
    manager.dispose();
  }
});
