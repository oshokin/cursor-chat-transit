import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { DeleteTarget } from '../src/deletion-types';
import type { ManagedNode } from '../src/managed-node';
import type * as vscode from 'vscode';
import type { TransitLog } from '../src/output-ui';
import type { WorkspaceEntry } from '../src/types';
import type { CatalogueJob, CatalogueUpdate } from '../src/workspace-catalogue';
import type { ManagedSearchItem } from '../src/managed-search';
import type { TransferJob } from '../src/transfer-process';
import type { StatisticsJob, StatisticsUpdate } from '../src/statistics';
import { workspaceStatisticsKey } from '../src/statistics';

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
const deletions: DeleteTarget[][] = [];
const registeredCommands = new Map<string, (node?: unknown) => Promise<void>>();
const nativeContexts = new Map<string, unknown>();
let registeredManager: import('../src/extension-manager').ChatManager;
let nativeSelection: ManagedNode[] = [];
const jobs: (TransferJob | StatisticsJob | CatalogueJob)[] = [];
let failRead = false;
let hideFirst = false;
let failedFirst = false;
let holdScan: (() => Promise<void>) | undefined;
const ui: Record<string, unknown> = {};
const messages: string[] = [];
let currentDatabase: string | undefined;
let searchPickers: ReturnType<typeof createSearchPicker>[] = [];

function createSearchPicker() {
  const listeners = new Map<string, () => void>();

  const picker = {
    busy: true,
    items: [] as ManagedSearchItem[],
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

const context = {
  globalState: {
    get: () => ['obsolete hidden state'],
    update: () => assert.fail('No manual hiding writes'),
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
        targets: DeleteTarget[],
      ) => {
        deletions.push(targets);

        return false;
      },
    };
  if (id === './extension-state')
    return {
      runtime: { uiState: ui },
      setUi: (value: object) => Object.assign(ui, value),
      withLock: async (_ctx: unknown, run: () => Promise<void>) => run(),
      linkedSignal: () => new AbortController().signal,
      finishPhaseProgress() {},
      attachPhaseProgress: () => () => {},
    };
  if (id === './extension-workspaces')
    return {
      listHostEntries: () => ({ entries }),
      currentWorkspaceDatabase: () => currentDatabase,
      prepareSqlite: async () => ({ executable: 'sqlite3', initFile: '' }),
    };
  if (id === './extension-settings') return { transferSettings: () => ({}) };
  if (id === './transfer-process')
    return {
      runTransfer: async (
        job: TransferJob | StatisticsJob | CatalogueJob,
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

        if (failRead) throw new Error('Database unavailable');

        if (job.kind === 'workspace-catalogue') {
          for (let index = 0; index < job.workspaces.length; index++)
            handlers.onCatalogue?.({
              index,
              headers: [{ composerId: 'found', name: 'Search target' }],
            });

          return { failed: 0 };
        }

        return { allComposers: [{ composerId: 'chat', name: 'Example' }] };
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
  holdScan = undefined;
  currentDatabase = undefined;
  searchPickers = [];
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
      (await manager.getChildren()).map((n) => n.workspace),
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

    await new Promise((resolve) => setImmediate(resolve));
    manager.refresh();
    holdScan = undefined;
    release();
    assert.deepEqual(await old, []);
    assert.equal((await manager.getChildren()).length, 2);
  } finally {
    manager.dispose();
  }
});

test('manager sorts the current physical workspace first using the picker order', async () => {
  currentDatabase = entries[1].workspaceDbPath;
  const manager = new Manager(context, log);

  try {
    assert.deepEqual(
      (await manager.getChildren()).map((n) => n.workspace),
      [entries[1], entries[0]],
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
      manager.selection.values().map((node) => node.workspace),
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
      { workspace: entries[0], ids: ['a'] },
      { workspace: entries[1], ids: ['b'] },
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
      [{ workspace: entries[0], ids: ['chat', 'sibling'] }],
    ]);

    assert.equal(jobs.filter((job) => job.kind === 'list-chats').length, 0);
  } finally {
    manager.dispose();
  }
});

test('hidden checked scopes stay in deletion and failed workspace expansion never submits a partial set', async () => {
  const manager = new Manager(context, log);

  try {
    hideFirst = true;
    const hidden = { workspace: entries[0] };
    const visible = { workspace: entries[1], chat: { composerId: 'visible' } };

    await manager.select(hidden, true);
    await manager.select(visible, true);
    assert.equal((await manager.getChildren()).length, 1);
    failRead = true;
    await assert.rejects(manager.deleteSelected(visible), /could not be read/);
    assert.deepEqual(deletions, []);
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
      [{ workspace: entries[0], ids: ['only'] }],
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
    const checked = [{ workspace: entries[0], ids: ['a', 'b'] }];

    assert.deepEqual(deletions.slice(2), [checked, checked]);
    registeredManager.clearSelection();

    assert.equal(
      nativeContexts.get('cursorChatTransit.manageHasCheckedItems'),
      false,
    );

    await row(focused);

    assert.deepEqual(deletions.at(-1), [
      { workspace: entries[1], ids: ['focused'] },
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

  assert.equal(rowDelete.length, 2);
  assert.equal(rowDelete[0].command, 'cursorChatTransit.manageDelete');

  assert.match(
    rowDelete[0].when,
    /&& cursorChatTransit.manageHasCheckedItems$/,
  );

  assert.equal(rowDelete[1].command, 'cursorChatTransit.manageDeleteItem');

  assert.match(
    rowDelete[1].when,
    /&& !cursorChatTransit.manageHasCheckedItems$/,
  );

  assert.equal(rowDelete[0].group, rowDelete[1].group);

  assert.deepEqual(
    menus['view/title']
      .filter((item: { command: string }) =>
        item.command.includes('manageDelete'),
      )
      .map((item: { command: string }) => item.command),
    ['cursorChatTransit.manageDelete'],
  );
});
