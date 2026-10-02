import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';

/** Compiled sidebar client used by the vm harness. */
const client = path.resolve('resources/sidebar-client.js');

/** Compile the webview before loading it so tests see current `hidden` behaviour. */
const compiled = spawnSync(
  process.execPath,
  [
    path.resolve('node_modules/typescript/bin/tsc'),
    '-p',
    'tsconfig.webview.json',
  ],
  { stdio: 'inherit', shell: false },
);

assert.equal(compiled.status, 0);

/** Minimal DOM node used to execute the compiled sidebar client. */
type FakeEl = {
  /** Whether the node is hidden. */
  hidden: boolean;
  /** Native disclosure state. */
  open?: boolean;
  /** Disabled state for buttons. */
  disabled?: boolean;
  /** `data-action` mirror. */
  dataset: {
    /** Sidebar button id posted to the host. */
    action?: string;
    /** Status mark mirrored onto the operation root. */
    status?: string;
  };
  /** Inline style used for the progress fill. */
  style: {
    /** Progress fill width, such as `40%`. */
    width?: string;
  };
  /** Attribute map, including `aria-valuenow`. */
  attributes: Record<string, string>;
  /** CSS class names. */
  classes: Set<string>;
  /** Text content; tests assert this is never interpreted as HTML. */
  textContent: string;
  /** no-op child replacement. */
  replaceChildren(): void;
  /** no-op append. */
  appendChild(child: FakeEl): void;
  /** no-op listener; the compiled client only needs the method to exist. */
  addEventListener(name: string, callback: () => void): void;
  /** Record an attribute. */
  setAttribute(key: string, value: string): void;
  /** Drop an attribute. */
  removeAttribute(key: string): void;
  /** classList.toggle used by the progress bar. */
  classList: {
    /** Add or remove one class name. */
    toggle(name: string, on?: boolean): void;
  };
};

/** Load the sidebar client into a stub document and return its message handler. */
function fakeDom() {
  const elements = new Map<string, FakeEl>();
  const buttons: FakeEl[] = [];

  /** Create or reuse a stub element for `id`. */
  const make = (id: string): FakeEl => {
    if (elements.has(id)) return elements.get(id)!;

    const el: FakeEl = {
      hidden: false,
      disabled: false,
      dataset: {},
      style: {},
      attributes: {},
      classes: new Set(),
      textContent: '',
      /** Drop every child of this fake element. */
      replaceChildren() {},
      /** Ignore an appended child. */
      appendChild() {},
      /** Ignore a DOM listener on this fake element. */
      addEventListener() {},
      /** Store one attribute on the fake element. */
      setAttribute(key, value) {
        this.attributes[key] = value;
      },
      /** Remove one attribute from the fake element. */
      removeAttribute(key) {
        delete this.attributes[key];
      },
      /** Class-list stub that records toggled names. */
      get classList() {
        return {
          toggle: (name: string, on?: boolean) => {
            if (on) el.classes.add(name);
            else el.classes.delete(name);
          },
        };
      },
    };

    elements.set(id, el);

    return el;
  };

  for (const action of [
    'export',
    'import',
    'chooseWorkspace',
    'cancel',
    'quitCursor',
    'diagnostics',
  ]) {
    const button = make(`btn-${action}`);

    button.dataset.action = action;
    buttons.push(button);
  }

  let receive: ((event: { data: unknown }) => void) | undefined;

  vm.runInNewContext(fs.readFileSync(client, 'utf8'), {
    acquireVsCodeApi: () => ({
      /** Ignore a message posted by the sidebar script. */
      postMessage() {},
    }),
    window: {
      /** Capture the window message listener installed by the sidebar. */
      addEventListener(
        _name: string,
        callback: (event: { data: unknown }) => void,
      ) {
        receive = callback;
      },
    },
    document: {
      querySelectorAll: () => buttons,
      getElementById: (id: string) => make(id),
      querySelector: (sel: string) =>
        sel === '.operation' || sel === '.status-mark'
          ? make(sel)
          : make('progress'),
      createElement: () => make('li'),
    },
  });

  assert.ok(receive);

  return { receive: receive!, el: make, buttons };
}

/** Deliver a host `state` message to the sidebar client. */
function send(
  receive: (event: { data: unknown }) => void,
  state: Record<string, unknown>,
): void {
  receive({ data: { type: 'state', state } });
}

test('idle hides the progress bar; busy without a percent shows it indeterminate', () => {
  const { receive, el, buttons } = fakeDom();

  send(receive, { busy: false, status: 'idle', sourceAvailable: true });
  assert.equal(el('progress').hidden, true);
  send(receive, { busy: true, status: 'running', sourceAvailable: true });
  assert.equal(el('progress').hidden, false);
  assert.equal(el('progress').classes.has('is-indeterminate'), true);
  assert.equal(el('progress').attributes['aria-valuenow'], undefined);

  assert.equal(
    buttons.find((b) => b.dataset.action === 'export')?.disabled,
    true,
  );

  send(receive, {
    busy: true,
    canCancel: true,
    status: 'running',
    sourceAvailable: true,
  });

  assert.equal(
    buttons.find((b) => b.dataset.action === 'cancel')?.hidden,
    false,
  );
});

test('finite percents are determinate; NaN and Infinity stay indeterminate', () => {
  const { receive, el } = fakeDom();

  for (const progress of [0, 25, 100]) {
    send(receive, {
      busy: true,
      status: 'running',
      progress,
      sourceAvailable: true,
    });

    assert.equal(el('progress').hidden, false);
    assert.equal(el('progress').classes.has('is-indeterminate'), false);
    assert.equal(el('progress-fill').style.width, `${progress}%`);
    assert.equal(el('progress').attributes['aria-valuenow'], String(progress));
  }

  for (const progress of [Number.NaN, Number.POSITIVE_INFINITY]) {
    send(receive, {
      busy: true,
      status: 'running',
      progress,
      sourceAvailable: true,
    });

    assert.equal(el('progress').classes.has('is-indeterminate'), true);
    assert.equal(el('progress').attributes['aria-valuenow'], undefined);
  }
});

test('completion and cancel hide the bar; labels stay text', () => {
  const { receive, el } = fakeDom();

  send(receive, {
    busy: true,
    status: 'running',
    progress: 40,
    workspaceName: '<b>not html</b>',
    sourceAvailable: true,
  });

  send(receive, {
    busy: false,
    status: 'completed',
    workspaceName: '<b>not html</b>',
    sourceAvailable: true,
  });

  assert.equal(el('progress').hidden, true);
  assert.equal(el('workspace-name').textContent, '<b>not html</b>');
  send(receive, { busy: false, status: 'cancelled', sourceAvailable: true });
  assert.equal(el('progress').hidden, true);
});

test('Quit is offered only for a completed import that added chats', () => {
  const { receive, el } = fakeDom();

  for (const status of ['completed', 'incomplete']) {
    send(receive, {
      busy: false,
      status,
      canQuitCursor: true,
      importNeedsRestart: true,
    });

    assert.equal(el('btn-quitCursor').hidden, false, status);
    assert.equal(el('btn-quitCursor').disabled, false, status);
  }
});

test('exports and imports without changes never offer Quit', () => {
  const { receive, el } = fakeDom();

  for (const status of [
    'completed',
    'incomplete',
    'failed',
    'partial',
    'cancelled',
    'idle',
    'waiting',
    'running',
  ]) {
    for (const importNeedsRestart of [false, undefined]) {
      send(receive, {
        busy: false,
        status,
        canQuitCursor: true,
        importNeedsRestart,
      });

      assert.equal(el('btn-quitCursor').hidden, true, status);
      assert.equal(el('btn-quitCursor').disabled, true, status);
    }
  }
});

test('busy, missing capability and unverified results override a stale restart flag', () => {
  const { receive, el } = fakeDom();

  for (const state of [
    { busy: true, status: 'completed', canQuitCursor: true },
    { busy: false, status: 'completed', canQuitCursor: false },
    ...['idle', 'waiting', 'running', 'failed', 'partial', 'cancelled'].map(
      (status) => ({ busy: false, status, canQuitCursor: true }),
    ),
  ]) {
    send(receive, { ...state, importNeedsRestart: true });
    assert.equal(el('btn-quitCursor').hidden, true);
    assert.equal(el('btn-quitCursor').disabled, true);
  }
});

test('waiting for input hides progress but keeps transfer and Quit actions blocked', () => {
  const { receive, el, buttons } = fakeDom();

  send(receive, { busy: true, status: 'running', sourceAvailable: true });
  assert.equal(el('progress').classes.has('is-indeterminate'), true);

  send(receive, {
    busy: true,
    status: 'waiting',
    sourceAvailable: true,
    canQuitCursor: true,
    canCancel: false,
  });

  assert.equal(el('.operation').dataset.status, 'waiting');
  assert.equal(el('progress').hidden, true);
  assert.equal(el('progress').classes.has('is-indeterminate'), false);
  assert.equal(el('.status-mark').textContent, '○');

  for (const action of ['export', 'import', 'chooseWorkspace', 'quitCursor']) {
    assert.equal(
      buttons.find((b) => b.dataset.action === action)?.disabled,
      true,
    );
  }

  assert.equal(el('btn-quitCursor').hidden, true);
  assert.equal(el('btn-cancel').hidden, true);
  send(receive, { busy: true, status: 'running', sourceAvailable: true });
  assert.equal(el('progress').hidden, false);
  assert.equal(el('progress').classes.has('is-indeterminate'), true);
});

test('terminal results hide progress even before lock cleanup finishes', () => {
  const { receive, el } = fakeDom();

  for (const status of [
    'completed',
    'incomplete',
    'failed',
    'partial',
    'cancelled',
  ]) {
    send(receive, { busy: true, status, progress: 100 });
    assert.equal(el('progress').hidden, true, status);
    assert.equal(el('progress').classes.has('is-indeterminate'), false, status);
  }
});

test('chat details collapse by default, preserve disclosure on refresh, and reset for a new result', () => {
  const { receive, el } = fakeDom();

  const s = {
    status: 'completed',
    statusTitle: 'Already imported',
    timingLabel: 'Total 1m 27s',
    statusItems: ['<b>plain text</b>', 'Second chat'],
  };

  send(receive, s);
  assert.equal(el('activity-details').hidden, false);
  assert.equal(el('activity-details').open, false);
  assert.equal(el('activity-summary').textContent, 'Chat details (2)');
  assert.equal(el('status-title').textContent, 'Already imported');
  assert.equal(el('timing-label').textContent, 'Total 1m 27s');
  el('activity-details').open = true;
  send(receive, s);
  assert.equal(el('activity-details').open, true);
  send(receive, { ...s, status: 'running', statusItems: [] });
  assert.equal(el('activity-details').hidden, true);
  send(receive, s);
  assert.equal(el('activity-details').open, false);
  send(receive, { ...s, statusItems: ['', null, 3] });
  assert.equal(el('activity-details').hidden, true);
});
