import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import childProcess from 'node:child_process';
import { installBlobFile } from '../src/resource-files';
import { validateBundleCapabilities } from '../src/bundle-capabilities';
import {
  visualizationScopeFiles,
  provisionVisualizationScope,
  localAgentStoreBase,
  assertVisualizationScope,
} from '../src/visualizations';
import type { WorkspaceEntry } from '../src/types';
import { pendingResourceMatches } from '../src/import-reconcile';
import { createHash } from 'node:crypto';
import {
  isVisualizationFilename,
  MAX_VISUALIZATION_BYTES,
  readVisualizationFile,
} from '../src/visualizations';

test('visualization basenames match the Cursor renderer contract', () => {
  for (const name of ['a.html', 'Chart-1.HTML', `${'a'.repeat(64)}.html`])
    assert.equal(isVisualizationFilename(name), true);
  for (const name of [
    '../a.html',
    'visualizations/a.html',
    '-a.html',
    'a-.html',
    'a_b.html',
    `${'a'.repeat(65)}.html`,
    'a.html?x',
  ])
    assert.equal(isVisualizationFilename(name), false);
});

test('clean target resolution is read-only; import creates private local files without sync identity', async () => {
  if (process.platform === 'win32') return;
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'clean-store-'));
  const previous = process.env.CURSOR_AGENT_STORE_DIR;

  process.env.CURSOR_AGENT_STORE_DIR = path.join(temp, 'destination');

  try {
    const workspace = {} as WorkspaceEntry;
    const scope = await visualizationScopeFiles({}, workspace, 'new-owner');

    await assert.rejects(fs.stat(process.env.CURSOR_AGENT_STORE_DIR), {
      code: 'ENOENT',
    });

    assert.equal(await readVisualizationFile(scope, 'chart.html'), null);

    assert.equal(
      await provisionVisualizationScope({}, workspace, 'new-owner'),
      scope,
    );

    assert.equal(
      (await fs.stat(process.env.CURSOR_AGENT_STORE_DIR)).mode & 0o777,
      0o700,
    );

    assert.equal((await fs.stat(scope)).mode & 0o777, 0o700);

    await assert.rejects(fs.stat(path.join(path.dirname(scope), '.sync')), {
      code: 'ENOENT',
    });

    await provisionVisualizationScope({}, workspace, 'new-owner');
    await fs.chmod(process.env.CURSOR_AGENT_STORE_DIR, 0o755);

    await assert.rejects(
      provisionVisualizationScope({}, workspace, 'other-owner'),
      /private/,
    );

    assert.equal(
      (await fs.stat(process.env.CURSOR_AGENT_STORE_DIR)).mode & 0o777,
      0o755,
    );
  } finally {
    if (previous === undefined) delete process.env.CURSOR_AGENT_STORE_DIR;
    else process.env.CURSOR_AGENT_STORE_DIR = previous;
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('provisioning rolls back empty owned directories after faults and retries safely', async (t) => {
  if (process.platform === 'win32') return;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'store-fault-'));
  const scope = path.join(root, 'new', 'files');
  const ctx = { resolveVisualizationScopeFiles: () => scope };
  const original = fs.mkdir.bind(fs);

  const mock = t.mock.method(
    fs,
    'mkdir',
    async (...args: Parameters<typeof fs.mkdir>) => {
      if (args[0] === scope)
        throw Object.assign(new Error('injected disk fault'), { code: 'EIO' });

      return Reflect.apply(original, fs, args);
    },
  );

  try {
    await assert.rejects(
      provisionVisualizationScope(ctx, {} as WorkspaceEntry, 'owner'),
      /injected/,
    );

    await assert.rejects(fs.stat(path.join(root, 'new')), { code: 'ENOENT' });
    mock.mock.restore();
    await provisionVisualizationScope(ctx, {} as WorkspaceEntry, 'owner');
    assert.equal((await fs.stat(scope)).mode & 0o777, 0o700);
  } finally {
    mock.mock.restore();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('foreign-owned scopes are refused without altering existing identity', async (t) => {
  if (process.platform === 'win32') return;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'store-foreign-'));
  const original = fs.lstat.bind(fs);
  const before = await original(root);

  t.mock.method(fs, 'lstat', async (...args: Parameters<typeof fs.lstat>) => {
    const stat = await Reflect.apply(original, fs, args);

    if (args[0] === root)
      Object.defineProperty(stat, 'uid', {
        value: (process.geteuid?.() ?? 0) + 1,
      });

    return stat;
  });

  try {
    await assert.rejects(
      provisionVisualizationScope(
        { resolveVisualizationScopeFiles: () => root },
        {} as WorkspaceEntry,
        'owner',
      ),
      /owned/,
    );

    assert.equal((await original(root)).ino, before.ino);
    assert.equal((await original(root)).mode, before.mode);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('store override is absolute and takes precedence without probing fallbacks', () => {
  const previous = process.env.CURSOR_AGENT_STORE_DIR;

  try {
    process.env.CURSOR_AGENT_STORE_DIR = 'relative';
    assert.throws(localAgentStoreBase, /absolute/);

    process.env.CURSOR_AGENT_STORE_DIR = path.join(
      os.tmpdir(),
      'explicit-store',
    );

    assert.equal(localAgentStoreBase(), process.env.CURSOR_AGENT_STORE_DIR);
  } finally {
    if (previous === undefined) delete process.env.CURSOR_AGENT_STORE_DIR;
    else process.env.CURSOR_AGENT_STORE_DIR = previous;
  }
});

test('Windows override remains read-only and import refuses unavailable ACL tooling', async (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const previous = process.env.CURSOR_AGENT_STORE_DIR;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'store-windows-'));
  const base = path.join(root, 'absent');

  t.mock.method(childProcess, 'execFile', (...args: unknown[]) => {
    const callback = args.at(-1) as (error: Error) => void;

    callback(new Error('ACL tooling unavailable'));
  });

  const systemRoot = process.env.SystemRoot;

  try {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    process.env.SystemRoot = 'C:\\Windows';
    process.env.CURSOR_AGENT_STORE_DIR = base;
    assert.equal(localAgentStoreBase(), base);
    await visualizationScopeFiles({}, {} as WorkspaceEntry, 'owner');

    await assert.rejects(
      provisionVisualizationScope({}, {} as WorkspaceEntry, 'owner'),
      /ACL/,
    );

    await assert.rejects(fs.stat(base), { code: 'ENOENT' });
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
    if (systemRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = systemRoot;
    if (previous === undefined) delete process.env.CURSOR_AGENT_STORE_DIR;
    else process.env.CURSOR_AGENT_STORE_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('visualization installation reuses identical bytes and refuses conflicts', async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'visualization-install-'),
  );

  try {
    const source = path.join(root, 'source');
    const destination = path.join(root, 'visualizations', 'chart.html');
    const bytes = Buffer.from([0, 255, 60, 62]);

    await fs.writeFile(source, bytes);
    await installBlobFile(path.dirname(destination), destination, source);
    await installBlobFile(path.dirname(destination), destination, source);
    assert.deepEqual(await fs.readFile(destination), bytes);
    await fs.writeFile(source, 'different');

    await assert.rejects(
      installBlobFile(path.dirname(destination), destination, source),
      /different data/,
    );

    assert.deepEqual(await fs.readFile(destination), bytes);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('visualization capability is explicit and unknown versions fail closed', () => {
  assert.deepEqual(
    validateBundleCapabilities({
      required: ['visualization-html-v1'],
      optional: [],
    }).required,
    ['visualization-html-v1'],
  );

  assert.throws(
    () =>
      validateBundleCapabilities({
        required: ['visualization-html-v2'],
        optional: [],
      }),
    /Unsupported required/,
  );
});

test('visualization resolver receives the destination owner and rejects unsafe scopes', async () => {
  const workspace = {} as WorkspaceEntry;

  const scope = await visualizationScopeFiles(
    {
      resolveVisualizationScopeFiles: ({ agentId, workspace: actual }) => {
        assert.equal(agentId, 'destination-agent');
        assert.equal(actual, workspace);

        return '/resolved/agent/files';
      },
    },
    workspace,
    'destination-agent',
  );

  assert.equal(scope, '/resolved/agent/files');

  await assert.rejects(
    visualizationScopeFiles({}, workspace, '../other-agent'),
    /owner/,
  );

  await assert.rejects(
    visualizationScopeFiles(
      { resolveVisualizationScopeFiles: () => 'relative' },
      workspace,
      'agent',
    ),
    /absolute/,
  );
});

test('pending visualization recovery verifies owning scope and refuses changed bytes', async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'visualization-recovery-'),
  );

  try {
    await fs.mkdir(path.join(root, 'visualizations'));
    const bytes = Buffer.from('opaque');

    await fs.writeFile(path.join(root, 'visualizations', 'chart.html'), bytes);

    const dep = {
      kind: 'visualization' as const,
      id: 'chart.html',
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };

    const opts = {
      workspace: {} as WorkspaceEntry,
      connGl: { database: '/unused' },
      plansDir: '/unused',
      canvasesDir: null,
      visualizationScopeFiles: root,
    };

    assert.equal(await pendingResourceMatches(dep, opts), true);

    assert.equal(
      await pendingResourceMatches(dep, {
        ...opts,
        visualizationScopeFiles: undefined,
      }),
      false,
    );

    await fs.writeFile(
      path.join(root, 'visualizations', 'chart.html'),
      'changed',
    );

    assert.equal(await pendingResourceMatches(dep, opts), false);
    await fs.rename(root, `${root}-real`);
    await fs.symlink(`${root}-real`, root);
    await assert.rejects(readVisualizationFile(root, 'chart.html'), /Unsafe/);
    await fs.unlink(root);
    await fs.rename(`${root}-real`, root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('an ancestor symlink does not make a real scope unsafe', async () => {
  const real = await fs.mkdtemp(path.join(os.tmpdir(), 'scope-real-'));
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'scope-link-'));
  const link = path.join(parent, 'via-link');

  await fs.symlink(real, link, 'dir');
  const scope = path.join(link, 'files');

  try {
    await assertVisualizationScope(scope);

    if (process.platform !== 'win32') {
      await provisionVisualizationScope(
        { resolveVisualizationScopeFiles: () => scope },
        {} as WorkspaceEntry,
        'owner',
      );

      assert.equal((await fs.stat(scope)).mode & 0o777, 0o700);
      await assertVisualizationScope(scope);
    }
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
    await fs.rm(real, { recursive: true, force: true });
  }
});

test('resolved visualization scope preserves opaque bytes and fails closed', async () => {
  const scope = await fs.mkdtemp(path.join(os.tmpdir(), 'visualization-'));

  try {
    const root = path.join(scope, 'visualizations');

    await fs.mkdir(root);

    const bytes = Buffer.from([
      0,
      255,
      ...Buffer.from('<script>throw 1</script>'),
    ]);

    await fs.writeFile(path.join(root, 'chart.html'), bytes);

    assert.deepEqual(
      (await readVisualizationFile(scope, 'chart.html'))?.bytes,
      bytes,
    );

    assert.equal(await readVisualizationFile(scope, 'missing.html'), null);
    await assert.rejects(readVisualizationFile(scope, '../chart.html'));
    await assert.rejects(readVisualizationFile('relative', 'chart.html'));

    await fs.symlink(
      path.join(root, 'chart.html'),
      path.join(root, 'linked.html'),
    );

    assert.equal(await readVisualizationFile(scope, 'linked.html'), null);

    await fs.writeFile(
      path.join(root, 'large.html'),
      Buffer.alloc(MAX_VISUALIZATION_BYTES),
    );

    assert.equal(
      (await readVisualizationFile(scope, 'large.html'))?.byteLength,
      MAX_VISUALIZATION_BYTES,
    );

    await fs.appendFile(path.join(root, 'large.html'), 'x');

    await assert.rejects(
      readVisualizationFile(scope, 'large.html'),
      /size limit/,
    );
  } finally {
    await fs.rm(scope, { recursive: true, force: true });
  }
});
