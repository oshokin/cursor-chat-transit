import test from 'node:test';
import assert from 'node:assert/strict';
import type * as vscode from 'vscode';
import {
  managedSearchItems,
  showManagedSearch,
  type ManagedSearchItem,
} from '../src/managed-search';
import type { WorkspaceEntry } from '../src/types';

const workspace = {
  storageRoot: '/profile',
  storageId: 'one',
  key: 'project',
  mtime: 0,
  workspaceDbPath: '/profile/one/state.vscdb',
  identity: { kind: 'folder', uri: { scheme: 'file', path: '/project' } },
} as WorkspaceEntry;

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function fixture(load: Parameters<typeof showManagedSearch>[0]['load']) {
  const listeners = new Map<string, () => void>();
  let rows: readonly ManagedSearchItem[] = [];

  const subscribe = (name: string, handler: () => void) => {
    listeners.set(name, handler);

    return { dispose: () => listeners.delete(name) };
  };

  const picker = {
    title: '',
    placeholder: '',
    value: 'Russian',
    busy: false,
    ignoreFocusOut: false,
    matchOnDescription: false,
    matchOnDetail: false,
    disposed: false,
    selectedItems: [] as readonly ManagedSearchItem[],
    activeItems: [] as readonly ManagedSearchItem[],
    get items() {
      return rows;
    },
    set items(next: readonly ManagedSearchItem[]) {
      rows = next;
      this.activeItems = [];
      this.selectedItems = [];
    },
    onDidAccept: (handler: () => void) => subscribe('accept', handler),
    onDidHide: (handler: () => void) => subscribe('hide', handler),
    show() {},
    hide() {
      listeners.get('hide')?.();
    },
    dispose() {
      this.disposed = true;
    },
  };

  const errors: unknown[] = [];

  const result = showManagedSearch({
    picker: picker as unknown as vscode.QuickPick<ManagedSearchItem>,
    load,
    onError: (error) => errors.push(error),
  });

  return { picker, errors, result, accept: () => listeners.get('accept')?.() };
}

test('search indexes titles and workspace paths, orders chats like the picker and preserves physical identity', () => {
  const rows = managedSearchItems(workspace, [
    { composerId: 'older', name: 'Russian comments', lastUpdatedAt: 1 },
    { composerId: 'untitled', lastUpdatedAt: 100 },
    { composerId: 'newer', name: 'Agent', lastUpdatedAt: 10 },
  ]);

  assert.deepEqual(
    rows.map((r) => r.node.chat?.composerId),
    [undefined, 'newer', 'older', 'untitled'],
  );

  assert.match(rows[1].detail || '', /\/project/);

  const second = managedSearchItems({ ...workspace, storageRoot: '/other' }, [
    { composerId: 'older', name: 'Russian comments' },
  ]);

  assert.notEqual(rows[2].key, second[1].key);
});

test('native search sorts cached and streamed groups together without resetting the query', async () => {
  const f = fixture(async (_signal, append) => {
    append(
      managedSearchItems(
        { ...workspace, storageId: 'later' },
        [],
        undefined,
        1,
      ),
    );

    append(
      managedSearchItems(
        workspace,
        [{ composerId: 'found', name: 'Russian comments' }],
        undefined,
        0,
      ),
    );

    return { failed: 0 };
  });

  await tick();
  assert.equal(f.picker.ignoreFocusOut, true);
  assert.equal(f.picker.matchOnDetail, true);
  assert.equal(f.picker.busy, false);
  assert.equal(f.picker.value, 'Russian');
  assert.equal(f.picker.items[0].node.workspace.storageId, 'one');
  f.picker.selectedItems = [f.picker.items[1]];
  f.accept();
  assert.equal((await f.result)?.chat?.composerId, 'found');
});

test('search dismissal cancels header loading and waits for cleanup; losing focus does not', async () => {
  let signal!: AbortSignal;
  let release!: () => void;

  const f = fixture(async (value) => {
    signal = value;

    await new Promise<void>((resolve) => {
      release = resolve;
    });

    return { failed: 0 };
  });

  await tick();
  if (!f.picker.ignoreFocusOut) f.picker.hide();
  assert.equal(signal.aborted, false);
  f.picker.hide();
  assert.equal(signal.aborted, true);
  let finished = false;

  void f.result.then(() => {
    finished = true;
  });

  await tick();
  assert.equal(finished, false);
  release();
  assert.equal(await f.result, undefined);
  assert.equal(f.picker.disposed, true);
});

test('search retains partial results and makes unavailable workspaces explicit', async () => {
  const f = fixture(async (_signal, append) => {
    append(managedSearchItems(workspace, [], 'Database unavailable'));

    return { failed: 1 };
  });

  await tick();
  assert.match(f.picker.title, /1 workspace unavailable/);
  assert.match(f.picker.items[0].detail || '', /Database unavailable/);
  f.picker.hide();
  await f.result;

  const failed = fixture(async () => {
    throw new Error('Read failed');
  });

  await tick();
  assert.equal(failed.errors.length, 1);
  assert.equal(failed.picker.busy, false);
  failed.picker.hide();
  await failed.result;
});

test('large header batches do not exceed the JavaScript argument limit', async () => {
  const row = managedSearchItems(workspace, [])[0];

  const f = fixture(async (_signal, append) => {
    append(Array.from({ length: 150_000 }, () => row));

    return { failed: 0 };
  });

  await tick();
  assert.equal(f.errors.length, 0);
  assert.equal(f.picker.items.length, 150_000);
  f.picker.hide();
  await f.result;
});
