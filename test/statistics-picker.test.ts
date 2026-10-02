import test from 'node:test';
import assert from 'node:assert/strict';
import type * as vscode from 'vscode';
import { showStatisticsPicker } from '../src/statistics-picker';
import type { StatisticsUpdate } from '../src/statistics';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

const row = (id: string) => ({
  id,
  label: id,
  detail: `/path/${id}`,
  picked: true,
});

type Row = ReturnType<typeof row>;

/** Fake native surface deliberately resets selection when items are replaced. */
function fixture(
  run: (
    signal: AbortSignal,
    update: (row: StatisticsUpdate) => void,
  ) => Promise<{ failed: number }>,
  action?: 'filter' | 'select',
) {
  let items: readonly Row[] = [];

  const handlers = new Map<
    string,
    (button?: vscode.QuickInputButton) => void
  >();

  const subscribe = (
    key: string,
    handler: (button?: vscode.QuickInputButton) => void,
  ) => {
    handlers.set(key, handler);

    return { dispose: () => handlers.delete(key) };
  };

  const picker = {
    title: '',
    value: 'needle',
    busy: false,
    enabled: true,
    disposed: false,
    buttons: [] as vscode.QuickInputButton[],
    selectedItems: [] as readonly Row[],
    activeItems: [] as readonly Row[],
    get items() {
      return items;
    },
    set items(value: readonly Row[]) {
      items = value;
      this.selectedItems = [];
      this.activeItems = [];
    },
    onDidTriggerButton: (handler: (button?: vscode.QuickInputButton) => void) =>
      subscribe('button', handler),
    onDidAccept: (handler: (button?: vscode.QuickInputButton) => void) =>
      subscribe('accept', handler),
    onDidHide: (handler: (button?: vscode.QuickInputButton) => void) =>
      subscribe('hide', handler),
    show() {},
    hide() {
      handlers.get('hide')?.();
    },
    dispose() {
      this.disposed = true;
    },
  };

  const errors: unknown[] = [];

  const done = showStatisticsPicker({
    picker: picker as unknown as vscode.QuickPick<Row>,
    items: [row('a'), row('b')],
    key: (item) => item.id,
    title: 'Chats',
    placeholder: 'Find',
    many: action !== 'filter',
    action,
    actionButton: action
      ? { iconPath: { id: 'filter' }, tooltip: 'Apply' }
      : undefined,
    restoreButton: { iconPath: { id: 'filter-filled' }, tooltip: 'Show all' },
    analyzeButton: { iconPath: { id: 'graph' }, tooltip: 'Analyze' },
    cancelButton: { iconPath: { id: 'debug-stop' }, tooltip: 'Stop' },
    run,
    onError: (error) => errors.push(error),
  });

  return {
    picker,
    done,
    errors,
    fire: (name: string, button = picker.buttons[0]) =>
      handlers.get(name)?.(button),
  };
}

test('analysis is opt-in and preserves filtering, checkboxes, focus, and row order', async () => {
  let calls = 0;
  let update!: (row: StatisticsUpdate) => void;
  let complete!: (result: { failed: number }) => void;

  const f = fixture(async (_signal, onUpdate) => {
    calls++;
    update = onUpdate;

    return new Promise((resolve) => {
      complete = resolve;
    });
  });

  assert.equal(calls, 0);
  assert.equal(f.picker.selectedItems.length, 2);
  f.fire('button');
  await tick();
  assert.equal(f.picker.enabled, true);
  assert.equal(f.picker.busy, true);
  f.picker.selectedItems = [f.picker.items[1]];
  f.picker.activeItems = [f.picker.items[1]];
  update({ key: 'a', detail: '3 user messages · Legacy format' });
  update({ key: 'b', detail: '2 user messages · Agent format' });
  complete({ failed: 0 });
  await tick();
  assert.equal(f.picker.busy, false);
  assert.equal(f.picker.value, 'needle');

  assert.deepEqual(
    f.picker.selectedItems.map((r) => r.id),
    ['b'],
  );

  assert.deepEqual(
    f.picker.activeItems.map((r) => r.id),
    ['b'],
  );

  assert.deepEqual(
    f.picker.items.map((r) => r.id),
    ['a', 'b'],
  );

  assert.match(f.picker.items[0].detail, /^3 user messages/);
  f.fire('accept');

  assert.deepEqual(
    (await f.done)?.map((r) => r.id),
    ['b'],
  );
});

test('Stop cancels one worker; repeated clicks cannot launch overlapping scans; retry works', async () => {
  let calls = 0;
  let signal!: AbortSignal;
  let end!: (result: { failed: number }) => void;

  const f = fixture(async (s) => {
    calls++;
    signal = s;

    return new Promise((resolve) => {
      end = resolve;
    });
  });

  f.fire('button');
  await tick();
  f.fire('button');
  f.fire('button');
  assert.equal(signal.aborted, true);
  assert.equal(calls, 1);
  end({ failed: 0 });
  await tick();
  assert.match(f.picker.title, /stopped/i);
  f.fire('button');
  await tick();
  assert.equal(calls, 2);
  end({ failed: 0 });
  await tick();
  f.picker.hide();
  assert.equal(await f.done, undefined);
});

test('closing ignores late results and waits for cancellation cleanup before resolving', async () => {
  let update!: (row: StatisticsUpdate) => void;
  let signal!: AbortSignal;
  let end!: (result: { failed: number }) => void;

  const f = fixture(async (s, onUpdate) => {
    signal = s;
    update = onUpdate;

    return new Promise((resolve) => {
      end = resolve;
    });
  });

  f.fire('button');
  await tick();
  f.picker.hide();
  assert.equal(signal.aborted, true);
  assert.equal(f.picker.disposed, true);
  let resolved = false;

  void f.done.then(() => {
    resolved = true;
  });

  update({ key: 'a', detail: 'Late result' });
  await tick();
  assert.equal(resolved, false);
  assert.doesNotMatch(f.picker.items[0].detail, /Late/);
  end({ failed: 0 });
  assert.equal(await f.done, undefined);
});

test('worker errors leave selection usable and expose a retry action', async () => {
  const f = fixture(async () => {
    throw new Error('Fixture failure');
  });

  f.fire('button');
  await tick();
  assert.equal(f.errors.length, 1);
  assert.equal(f.picker.busy, false);
  assert.match(f.picker.title, /failed/i);
  assert.equal(f.picker.buttons[0].tooltip, 'Analyze');
  f.fire('accept');
  assert.equal((await f.done)?.length, 2);
});

test('workspace filter hides only confirmed empty rows and Show all restores the original list', async () => {
  let calls = 0;

  const f = fixture(async (_signal, update) => {
    calls++;
    update({ key: 'a', detail: '0 titled · 0 untitled', hide: true });
    update({ key: 'b', detail: 'Unreadable', failed: true });

    return { failed: 1 };
  }, 'filter');

  assert.deepEqual(
    f.picker.buttons.map((b) => b.tooltip),
    ['Analyze', 'Apply'],
  );

  f.fire('button', f.picker.buttons[1]);
  await tick();

  assert.deepEqual(
    f.picker.items.map((r) => r.id),
    ['b'],
  );

  assert.equal(f.picker.buttons[1].tooltip, 'Show all');
  f.fire('button', f.picker.buttons[1]);

  assert.deepEqual(
    f.picker.items.map((r) => r.id),
    ['a', 'b'],
  );

  assert.equal(calls, 1);
  f.picker.hide();
  await f.done;
});

test('checked selection applies only complete results and never treats an error as eligible', async () => {
  const f = fixture(async (_signal, update) => {
    update({ key: 'a', detail: 'Transfer checks passed', eligible: true });
    update({ key: 'b', detail: 'Unreadable', eligible: true, failed: true });

    return { failed: 1 };
  }, 'select');

  f.fire('button', f.picker.buttons[1]);
  await tick();

  assert.deepEqual(
    f.picker.selectedItems.map((r) => r.id),
    ['a'],
  );

  f.fire('accept');
  assert.equal((await f.done)?.length, 1);
});

test('cancelling a check keeps the original selection instead of applying partial results', async () => {
  let finish!: (r: { failed: number }) => void;

  const f = fixture(async (_s, update) => {
    update({ key: 'a', detail: 'Ready', eligible: true });

    return new Promise((resolve) => {
      finish = resolve;
    });
  }, 'select');

  f.fire('button', f.picker.buttons[1]);
  await tick();
  f.fire('button');
  finish({ failed: 0 });
  await tick();

  assert.deepEqual(
    f.picker.selectedItems.map((r) => r.id),
    ['a', 'b'],
  );

  f.picker.hide();
  await f.done;
});

test('manual checkbox changes during a check win over late automatic selection', async () => {
  let finish!: (r: { failed: number }) => void;

  const f = fixture(async (_s, update) => {
    update({ key: 'a', detail: 'Ready', eligible: true });

    return new Promise((resolve) => {
      finish = resolve;
    });
  }, 'select');

  f.fire('button', f.picker.buttons[1]);
  await tick();
  f.picker.selectedItems = [f.picker.items[1]];
  finish({ failed: 0 });
  await tick();

  assert.deepEqual(
    f.picker.selectedItems.map((r) => r.id),
    ['b'],
  );

  assert.match(f.picker.title, /selection was kept/);
  f.picker.hide();
  await f.done;
});
