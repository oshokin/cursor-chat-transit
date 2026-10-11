import test from 'node:test';
import assert from 'node:assert/strict';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { WorkspaceEntry } from '../src/types';
import {
  assertStorageId,
  currentWindowMessage,
  databaseToken,
  removeWorkspaceDirectory,
  resolveWorkspaceDirectory,
  workspaceDataRefusal,
} from '../src/workspace-removal';
import { allowAccess, denyAccess } from './access';

async function layout(): Promise<{ root: string; entry: WorkspaceEntry }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cct-remove-'));
  const storageId = 'storage one';
  const directory = path.join(root, 'User', 'workspaceStorage', storageId);
  const globalDir = path.join(root, 'User', 'globalStorage');

  await mkdir(directory, { recursive: true });
  await mkdir(globalDir, { recursive: true });
  await writeFile(path.join(directory, 'state.vscdb'), '');
  await writeFile(path.join(globalDir, 'state.vscdb'), '');
  await writeFile(path.join(root, 'project-sentinel'), 'keep');

  return {
    root,
    entry: {
      storageRoot: root,
      storageId,
      workspaceDbPath: path.join(directory, 'state.vscdb'),
      globalDbPath: path.join(globalDir, 'state.vscdb'),
      mtime: 0,
      key: storageId,
      identity: {
        kind: 'folder',
        uri: {
          scheme: 'file',
          authority: '',
          path: path.join(root, 'project'),
        },
      },
    },
  };
}

test('storage ids cannot escape the workspaceStorage child', () => {
  for (const id of ['..', '/tmp/x', 'C:\\x', 'a/b', 'a\\b', 'a:b', 'a\0b', ''])
    assert.throws(() => assertStorageId(id));
  assertStorageId('storage one');
});

test('a real child directory is accepted and an internal link is not followed', async () => {
  const { root, entry } = await layout();
  const outside = path.join(root, 'outside');

  await writeFile(outside, 'keep');

  await symlink(
    outside,
    path.join(path.dirname(entry.workspaceDbPath), 'link'),
  );

  try {
    const directory = await resolveWorkspaceDirectory(root, entry);

    assert.equal(directory, path.dirname(entry.workspaceDbPath));
    await removeWorkspaceDirectory(directory);
    await assert.rejects(lstat(directory));
    assert.equal(await readFile(outside, 'utf8'), 'keep');

    assert.equal(
      await readFile(path.join(root, 'project-sentinel'), 'utf8'),
      'keep',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a symlinked workspace directory is refused and the external sentinel stays', async () => {
  const { root, entry } = await layout();
  const external = await mkdtemp(path.join(os.tmpdir(), 'cct-external-'));

  await writeFile(path.join(external, 'sentinel'), 'keep');
  const linked = path.join(root, 'User', 'workspaceStorage', 'linked');

  await symlink(external, linked, 'dir');

  try {
    await assert.rejects(
      resolveWorkspaceDirectory(root, {
        ...entry,
        storageId: 'linked',
        workspaceDbPath: path.join(linked, 'state.vscdb'),
      }),
    );

    assert.equal(
      await readFile(path.join(external, 'sentinel'), 'utf8'),
      'keep',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});

test('a symlink ancestor does not block a real workspace directory', async () => {
  const { root, entry } = await layout();
  const link = path.join(os.tmpdir(), `cct-link-${path.basename(root)}`);

  await symlink(root, link, 'dir');

  try {
    const directory = await resolveWorkspaceDirectory(link, {
      ...entry,
      storageRoot: link,
      workspaceDbPath: path.join(
        link,
        'User',
        'workspaceStorage',
        entry.storageId,
        'state.vscdb',
      ),
      globalDbPath: path.join(link, 'User', 'globalStorage', 'state.vscdb'),
    });

    assert.equal(
      await realpath(directory),
      await realpath(path.dirname(entry.workspaceDbPath)),
    );
  } finally {
    await unlink(link);
    await rm(root, { recursive: true, force: true });
  }
});

test('a global database from another profile is refused and the workspace stays', async () => {
  const { root, entry } = await layout();
  const elsewhere = await mkdtemp(path.join(os.tmpdir(), 'cct-other-profile-'));

  await writeFile(path.join(elsewhere, 'state.vscdb'), '');

  try {
    await assert.rejects(
      resolveWorkspaceDirectory(root, {
        ...entry,
        globalDbPath: path.join(elsewhere, 'state.vscdb'),
      }),
    );

    await lstat(entry.workspaceDbPath);

    assert.equal(
      await readFile(path.join(root, 'project-sentinel'), 'utf8'),
      'keep',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(elsewhere, { recursive: true, force: true });
  }
});

test('a project directory inside workspace storage is refused', async () => {
  const { root, entry } = await layout();
  const project = path.join(path.dirname(entry.workspaceDbPath), 'project');

  await mkdir(project);
  await writeFile(path.join(project, 'sentinel'), 'keep');

  try {
    await assert.rejects(
      resolveWorkspaceDirectory(root, {
        ...entry,
        identity: {
          kind: 'folder',
          uri: { scheme: 'file', authority: '', path: project },
        },
      }),
    );

    assert.equal(
      await readFile(path.join(project, 'sentinel'), 'utf8'),
      'keep',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('unicode names and quotes address the exact directory', async () => {
  const { root, entry } = await layout();
  const storageId = 'хранилище «кавычки»';
  const directory = path.join(root, 'User', 'workspaceStorage', storageId);

  await mkdir(directory);
  await writeFile(path.join(directory, 'state.vscdb'), '');
  await writeFile(path.join(root, 'вне «проекта»'), 'keep');

  try {
    const resolved = await resolveWorkspaceDirectory(root, {
      ...entry,
      storageId,
      key: storageId,
      workspaceDbPath: path.join(directory, 'state.vscdb'),
    });

    assert.equal(resolved, directory);
    await removeWorkspaceDirectory(resolved);
    await assert.rejects(lstat(directory));

    assert.equal(
      await readFile(path.join(root, 'вне «проекта»'), 'utf8'),
      'keep',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an empty window can delete another workspace, and an unknown current window cannot', () => {
  const entry: WorkspaceEntry = {
    storageRoot: '/profile',
    storageId: 'abc',
    workspaceDbPath: '/profile/User/workspaceStorage/abc/state.vscdb',
    globalDbPath: '/profile/User/globalStorage/state.vscdb',
    mtime: 0,
    key: 'abc',
    identity: {
      kind: 'folder',
      uri: { scheme: 'file', authority: '', path: '/projects/demo' },
    },
  };

  assert.equal(workspaceDataRefusal(entry, { emptyWindow: true }), undefined);

  assert.equal(
    workspaceDataRefusal(entry, { emptyWindow: false }),
    currentWindowMessage,
  );

  assert.equal(
    workspaceDataRefusal(entry, {
      emptyWindow: false,
      identity: entry.identity,
    }),
    currentWindowMessage,
  );
});

test('an unresolved current database still refuses the matching identity', async () => {
  const { root, entry } = await layout();

  try {
    assert.equal(
      workspaceDataRefusal(
        entry,
        {
          database: '/missing/current.vscdb',
          identity: entry.identity,
          emptyWindow: false,
        },
        { target: entry.workspaceDbPath },
      ),
      currentWindowMessage,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a WAL that cannot be stat is not treated as absent', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cct-wal-'));
  const directory = path.join(root, 'db');
  const database = path.join(directory, 'state.vscdb');

  try {
    await mkdir(directory);
    await writeFile(database, 'db');
    await writeFile(`${database}-wal`, 'wal');
    await denyAccess(directory);

    await assert.rejects(
      databaseToken(database),
      (error: NodeJS.ErrnoException) => {
        assert.ok(
          error.code === 'EACCES' || error.code === 'EPERM',
          error.code,
        );

        return true;
      },
    );
  } finally {
    await allowAccess(directory);
    await rm(root, { recursive: true, force: true });
  }
});
