import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  listWorkspaceEntries,
  listWorkspaceEntriesAsync,
  listWorkspaceInventory,
  preferStorageRoot,
  readStorageEntry,
} from '../src/paths';

test('an invalid explicit storage root fails instead of selecting another paired root', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cct-paths-'));

  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const configured = path.join(dir, 'explicit-fixture');
  const fakeDefault = path.join(dir, 'Cursor');

  await fs.mkdir(path.join(configured, 'User/workspaceStorage'), {
    recursive: true,
  });

  await fs.mkdir(path.join(fakeDefault, 'User/workspaceStorage'), {
    recursive: true,
  });

  await fs.mkdir(path.join(fakeDefault, 'User/globalStorage'), {
    recursive: true,
  });

  await fs.writeFile(
    path.join(fakeDefault, 'User/globalStorage/state.vscdb'),
    'synthetic placeholder',
  );

  const previous = process.env.XDG_CONFIG_HOME;

  process.env.XDG_CONFIG_HOME = dir;

  try {
    assert.throws(
      () => preferStorageRoot({ configuredUserDataDir: configured }),
      /incomplete/,
    );
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
  }
});

test('default Cursor paths use the client OS and absolute XDG paths only', async () => {
  const { getDefaultCursorUserDir } = await import('../src/paths');

  assert.equal(
    getDefaultCursorUserDir('darwin', '/Users/oleg', {}),
    '/Users/oleg/Library/Application Support/Cursor',
  );

  assert.equal(
    getDefaultCursorUserDir('win32', 'C:\\Users\\Oleg Shokin', {
      APPDATA: 'D:\\Roaming',
    }),
    'D:\\Roaming\\Cursor',
  );

  assert.equal(
    getDefaultCursorUserDir('win32', 'C:\\Users\\Oleg Shokin', {}),
    'C:\\Users\\Oleg Shokin\\AppData\\Roaming\\Cursor',
  );

  assert.equal(
    getDefaultCursorUserDir('linux', '/home/oshokin', {
      XDG_CONFIG_HOME: '/data/config',
    }),
    '/data/config/Cursor',
  );

  assert.equal(
    getDefaultCursorUserDir('linux', '/home/oshokin', {
      XDG_CONFIG_HOME: 'relative',
    }),
    '/home/oshokin/.config/Cursor',
  );
});

test('workspace activity includes WAL writes and ignores non-file databases', async (t) => {
  const { listWorkspaceEntries } = await import('../src/paths');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'transit-wal-'));

  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const storage = path.join(dir, 'User', 'workspaceStorage');

  await fs.mkdir(path.join(storage, 'one'), { recursive: true });
  await fs.mkdir(path.join(storage, 'bad', 'state.vscdb'), { recursive: true });
  const db = path.join(storage, 'one', 'state.vscdb');

  await fs.writeFile(db, '');
  await fs.writeFile(`${db}-wal`, '');
  await fs.utimes(db, 1000, 1000);
  await fs.utimes(`${db}-wal`, 2000, 2000);
  const entries = listWorkspaceEntries(dir);

  assert.equal(entries.length, 1);
  assert.equal(entries[0].mtime, 2000000);
  await fs.unlink(`${db}-wal`);
  assert.equal(listWorkspaceEntries(dir)[0].mtime, 1000000);
});

test('a directory without state.vscdb is manage-only and not a transfer source', async (t) => {
  const { listIncompleteWorkspaceDirs, listWorkspaceEntries } =
    await import('../src/paths');

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cct-residue-'));

  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const storage = path.join(dir, 'User', 'workspaceStorage');

  await fs.mkdir(path.join(storage, 'residue'), { recursive: true });
  await fs.mkdir(path.join(storage, 'ready'), { recursive: true });
  await fs.writeFile(path.join(storage, 'ready', 'state.vscdb'), '');

  await fs.symlink(
    path.join(storage, 'residue'),
    path.join(storage, 'linked'),
    'dir',
  );

  assert.deepEqual(listIncompleteWorkspaceDirs(dir), ['residue']);

  assert.deepEqual(
    listWorkspaceEntries(dir).map((entry) => entry.storageId),
    ['ready'],
  );
});

test('a destination reread loads only the named storage', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cct-one-storage-'));

  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const storage = path.join(dir, 'User', 'workspaceStorage');

  for (const id of ['target', 'other']) {
    const folder = path.join(storage, id);

    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, 'state.vscdb'), '');

    await fs.writeFile(
      path.join(folder, 'workspace.json'),
      JSON.stringify({ folder: `file:///tmp/${id}` }),
    );
  }

  const entry = await readStorageEntry(dir, 'target');

  assert.equal(entry?.storageId, 'target');
  assert.equal(entry?.identity?.uri.path, '/tmp/target');
  assert.equal(await readStorageEntry(dir, 'missing'), undefined);
});

test('async inventory matches the sync list and a cancelled snapshot is empty', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cct-async-inventory-'));

  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const storage = path.join(dir, 'User', 'workspaceStorage');

  for (const [id, mtime] of [
    ['older', 1_000],
    ['newer', 2_000],
  ] as const) {
    const folder = path.join(storage, id);

    await fs.mkdir(folder, { recursive: true });
    const db = path.join(folder, 'state.vscdb');

    await fs.writeFile(db, '');
    await fs.utimes(db, mtime / 1000, mtime / 1000);

    await fs.writeFile(
      path.join(folder, 'workspace.json'),
      JSON.stringify({ folder: `file:///tmp/${id}` }),
    );
  }

  const listed = listWorkspaceEntries(dir);
  const asyncListed = await listWorkspaceEntriesAsync(dir);

  assert.deepEqual(
    asyncListed.map((item) => item.storageId),
    listed.map((item) => item.storageId),
  );

  assert.deepEqual(
    asyncListed.map((item) => item.storageId),
    ['newer', 'older'],
  );

  const cancelled = new AbortController();

  cancelled.abort();

  assert.deepEqual(
    await listWorkspaceEntriesAsync(dir, { signal: cancelled.signal }),
    [],
  );
});

test('one inventory pass returns databases and incomplete directories', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cct-inventory-both-'));

  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const storage = path.join(dir, 'User', 'workspaceStorage');

  await fs.mkdir(path.join(storage, 'ready'), { recursive: true });
  await fs.mkdir(path.join(storage, 'residue'), { recursive: true });
  await fs.writeFile(path.join(storage, 'ready', 'state.vscdb'), '');

  const listed = await listWorkspaceInventory(dir);

  assert.deepEqual(
    listed.entries.map((entry) => entry.storageId),
    ['ready'],
  );

  assert.deepEqual(listed.incompleteIds, ['residue']);
});
