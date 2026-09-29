import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import path from 'node:path';

/** vscode.Uri.joinPath built from node path. */
const Uri = {
  joinPath(base: { fsPath: string }, ...parts: string[]) {
    return { fsPath: path.join(base.fsPath, ...parts) };
  },
};
/** vscode module stub used to resolve the packaged sidebar. */
const fakeVscode = {
  Uri,
  window: {},
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
/** Sidebar provider loaded against the vscode stub. */
let sidebar: typeof import('../src/sidebar-provider');
try {
  sidebar = require('../src/sidebar-provider') as typeof sidebar;
} finally {
  loader._load = original;
}

test('resolveWebviewView substitutes assets and keeps a strict CSP nonce', async () => {
  const root = path.resolve(__dirname, '..');
  const provider = new sidebar.TransferSidebar(
    {
      extensionUri: { fsPath: root },
      subscriptions: [],
    } as never,
    () =>
      ({
        workspaceName: 'Choose a workspace',
        workspaceDetail: '',
        sourceAvailable: false,
        busy: false,
        canCancel: false,
        status: 'idle',
        statusTitle: '',
        statusDetail: '',
      }) as never,
    async () => undefined,
    () => undefined,
  );
  const view = {
    webview: {
      options: {
        enableScripts: false,
        localResourceRoots: [] as Array<{ fsPath: string }>,
      },
      cspSource: 'https://csp.test',
      html: '',
      asWebviewUri(uri: { fsPath: string }) {
        return {
          toString: () => `https://webview.test/${path.basename(uri.fsPath)}`,
        };
      },
      onDidReceiveMessage() {
        return { dispose() {} };
      },
      postMessage() {},
    },
    onDidChangeVisibility() {
      return { dispose() {} };
    },
    visible: true,
  };
  await provider.resolveWebviewView(view as never);
  assert.equal(view.webview.options.enableScripts, true);
  assert.equal(view.webview.options.localResourceRoots?.length, 1);
  assert.equal(
    view.webview.options.localResourceRoots?.[0]?.fsPath,
    path.join(root, 'resources'),
  );
  assert.doesNotMatch(view.webview.html, /%%/);
  assert.match(
    view.webview.html,
    /src="https:\/\/webview\.test\/sidebar-client\.js"/,
  );
  assert.match(view.webview.html, /script-src 'nonce-[A-Za-z0-9+/=]+'/);
  assert.match(view.webview.html, /Quit Cursor/);
  // This fixed action group may contain buttons and whitespace, never bare text.
  // Check the rendered template, not the fake DOM used by client-state tests.
  const actions = view.webview.html.match(
    /<div class="status-actions operation-actions">([\s\S]*?)<\/div>/,
  )?.[1];
  assert.ok(actions, 'operation action group must exist');
  const buttons = [
    ...actions.matchAll(/<button\b[^>]*>[\s\S]*?<\/button\s*>/g),
  ];
  assert.equal(buttons.length, 3);
  assert.deepEqual(
    buttons.map((match) => match[0].match(/data-action="([^"]+)"/)?.[1]),
    ['logs', 'quitCursor', 'cancel'],
  );
  assert.equal(
    actions.replace(/<button\b[^>]*>[\s\S]*?<\/button\s*>/g, '').trim(),
    '',
    'Unexpected visible text between operation buttons (for example a stray >)',
  );
});
