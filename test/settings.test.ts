import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import path from 'node:path';
import fs from 'node:fs';

/** Inspected setting values keyed by `cursorChatTransit.*` suffix. */
const values = new Map<
  string,
  {
    globalValue?: unknown;
    workspaceValue?: unknown;
    workspaceFolderValue?: unknown;
  }
>();

/** Configuration namespaces requested through the vscode stub. */
const namespaces: string[] = [];

/** Node module loader, used to intercept `require('vscode')`. */
const loader = Module as unknown as {
  /** Node's internal module loader, replaced for the duration of the test. */
  _load(id: string, parent: unknown, isMain: boolean): unknown;
};

/** Original Node module loader. */
const original = loader._load;

loader._load = function (id, parent, isMain) {
  if (id !== 'vscode') return original.call(this, id, parent, isMain);

  return {
    workspace: {
      /** Record which settings namespace was requested. */
      getConfiguration(namespace: string) {
        namespaces.push(namespace);

        return {
          /** Return the fixture value stored for this setting key. */
          inspect(key: string) {
            return values.get(key);
          },
        };
      },
    },
  };
};

/** Settings module loaded against the vscode stub. */
let settings: typeof import('../src/extension-settings');

try {
  settings = require('../src/extension-settings') as typeof settings;
} finally {
  loader._load = original;
}

test('Transit settings use documented defaults and only the new namespace', () => {
  values.clear();
  namespaces.length = 0;
  assert.deepEqual(settings.config(), { userDataDir: '', sqlitePath: '' });

  assert.deepEqual(settings.transferSettings(), {
    timeoutMs: 600000,
    busyTimeoutMs: 5000,
    plansDir: undefined,
  });

  assert.equal(settings.importAllowPartial(), false);
  assert.equal(settings.operationLogLevel(), 'info');
  assert.ok(namespaces.every((namespace) => namespace === 'cursorChatTransit'));
});

test('log level accepts only info, warn, and error from the user setting', () => {
  values.clear();
  values.set('logLevel', { globalValue: 'warn', workspaceValue: 'error' });
  assert.equal(settings.operationLogLevel(), 'warn');
  values.set('logLevel', { globalValue: 'error' });
  assert.equal(settings.operationLogLevel(), 'error');
  values.set('logLevel', { globalValue: 'debug' });
  assert.equal(settings.operationLogLevel(), 'info');
  values.set('logLevel', { workspaceValue: 'error' });
  assert.equal(settings.operationLogLevel(), 'info');
});

test('workspace overrides cannot redirect a valid user path or silently enable recovery', () => {
  values.clear();
  const userDir = path.resolve('trusted-profile');

  values.set('userDataDir', {
    globalValue: userDir,
    workspaceValue: path.resolve('repository-profile'),
  });

  values.set('sqlitePath', {
    workspaceFolderValue: path.resolve('untrusted-binary'),
  });

  values.set('import.allowPartial', { workspaceValue: true });
  values.set('sqlite.operationTimeoutSeconds', { workspaceValue: 999 });
  assert.deepEqual(settings.config(), { userDataDir: userDir, sqlitePath: '' });
  assert.equal(settings.importAllowPartial(), false);
  assert.equal(settings.transferSettings().timeoutMs, 600000);
});

test('settings convert seconds once and validate JSON values as well as Settings UI values', () => {
  values.clear();
  values.set('sqlite.operationTimeoutSeconds', { globalValue: 900 });
  values.set('sqlite.busyTimeoutSeconds', { globalValue: 0 });
  values.set('plansDirectory', { globalValue: path.resolve('plans') });
  const result = settings.transferSettings();

  assert.equal(result.timeoutMs, 900000);
  assert.equal(result.busyTimeoutMs, 0);
  assert.equal(result.plansDir, path.resolve('plans'));

  for (const bad of ['600', null, -1, 29, 3601, 60.5, NaN]) {
    values.set('sqlite.operationTimeoutSeconds', { globalValue: bad });
    assert.throws(() => settings.transferSettings(), /whole number/);
  }

  values.clear();
  values.set('plansDirectory', { globalValue: 'relative/path' });
  assert.throws(() => settings.transferSettings(), /absolute path/);
});

test('all contributed settings use Transit prefix and retain appropriate scopes', () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'),
  );

  const properties = manifest.contributes.configuration.properties;

  assert.equal(Object.keys(properties).length, 7);

  assert.ok(
    Object.keys(properties).every((name) =>
      name.startsWith('cursorChatTransit.'),
    ),
  );

  assert.equal(
    properties['cursorChatTransit.import.allowPartial'].scope,
    'application',
  );

  assert.equal(
    properties['cursorChatTransit.sqlite.operationTimeoutSeconds'].default,
    600,
  );

  assert.equal(properties['cursorChatTransit.logLevel'].default, 'info');
  assert.equal(properties['cursorChatTransit.logLevel'].scope, 'application');

  assert.equal(
    properties['cursorChatTransit.sqlite.busyTimeoutSeconds'].scope,
    'machine',
  );
});
