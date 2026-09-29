import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { preferStorageRoot } from '../src/paths';

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
    getDefaultCursorUserDir('win32', 'C:\\Users\\oleg', {
      APPDATA: 'D:\\Roaming',
    }),
    'D:\\Roaming\\Cursor',
  );
  assert.equal(
    getDefaultCursorUserDir('win32', 'C:\\Users\\oleg', {}),
    'C:\\Users\\oleg\\AppData\\Roaming\\Cursor',
  );
  assert.equal(
    getDefaultCursorUserDir('linux', '/home/oleg', {
      XDG_CONFIG_HOME: '/data/config',
    }),
    '/data/config/Cursor',
  );
  assert.equal(
    getDefaultCursorUserDir('linux', '/home/oleg', {
      XDG_CONFIG_HOME: 'relative',
    }),
    '/home/oleg/.config/Cursor',
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
