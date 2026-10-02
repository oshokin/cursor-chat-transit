import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { workspaceKey } from '../src/core';
import * as paths from '../src/paths';
import {
  chatListLabel,
  chatPickItems,
  workspacePickItems,
  workspacePickTitle,
} from '../src/picker';
import type { WorkspaceEntry, WorkspaceIdentity } from '../src/types';

/** Folder id that looks like a millisecond timestamp. */
const numericId = '1790418430150';

/** URI parts for a workspace identity. */
function uri(
  authority: string,
  filePath = '/home/oshokin/project',
  scheme = 'vscode-remote',
) {
  return { scheme, authority, path: filePath, query: '', fragment: '' };
}

/** Workspace storage entry used as picker input. */
function entry(
  storageId: string,
  identity?: WorkspaceIdentity,
): WorkspaceEntry {
  return {
    storageRoot: '/tmp',
    storageId,
    workspaceDbPath: '/tmp/ws',
    globalDbPath: '/tmp/gl',
    mtime: 0,
    identity,
    key: identity
      ? workspaceKey(identity.kind, identity.uri)
      : `id:${storageId}`,
  };
}

/** User-data tree with synthetic workspaceStorage folders. */
async function userDirWithWorkspaces(
  t: { after: (fn: () => Promise<void>) => void },
  folders: Array<{
    id: string;
    meta?: 'missing' | 'corrupt' | 'unsupported' | Record<string, unknown>;
    mtime?: number;
  }>,
): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cct-picker-'));

  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  for (const folder of folders) {
    const storage = path.join(dir, 'User', 'workspaceStorage', folder.id);

    await fs.mkdir(storage, { recursive: true });
    const dbPath = path.join(storage, 'state.vscdb');

    await fs.writeFile(dbPath, '');

    if (folder.mtime !== undefined) {
      await fs.utimes(dbPath, folder.mtime / 1000, folder.mtime / 1000);
    }

    if (folder.meta === undefined || folder.meta === 'missing') continue;
    const jsonPath = path.join(storage, 'workspace.json');

    if (folder.meta === 'corrupt') {
      await fs.writeFile(jsonPath, '{not-json');
    } else if (folder.meta === 'unsupported') {
      await fs.writeFile(jsonPath, JSON.stringify({ configuration: 'x' }));
    } else {
      await fs.writeFile(jsonPath, JSON.stringify(folder.meta));
    }
  }

  return dir;
}

test('missing workspace.json uses an unidentified label, not the storage id', async (t) => {
  const dir = await userDirWithWorkspaces(t, [
    { id: numericId, meta: 'missing' },
  ]);

  const listed = paths.listWorkspaceEntries(dir);

  assert.equal(listed.length, 1);
  assert.equal(listed[0].identity, undefined);
  assert.equal(paths.displayLabel(listed[0]), 'Unidentified workspace');
  const item = workspacePickItems(listed, undefined)[0];

  assert.equal(item.label, 'Unidentified workspace');
  assert.equal(item.description, 'Workspace name unavailable');
  assert.equal(item.detail, `Storage ID: ${numericId}`);
  assert.equal(item.label.includes(numericId), false);
  assert.equal(item.description.includes(numericId), false);
  assert.doesNotMatch(item.label, /Empty window/i);
});

test('corrupt workspace.json uses an unidentified label', async (t) => {
  const dir = await userDirWithWorkspaces(t, [
    { id: numericId, meta: 'corrupt' },
  ]);

  const item = workspacePickItems(
    paths.listWorkspaceEntries(dir),
    undefined,
  )[0];

  assert.equal(item.label, 'Unidentified workspace');
  assert.equal(item.detail, `Storage ID: ${numericId}`);
});

test('unsupported workspace metadata uses an unidentified label', async (t) => {
  const dir = await userDirWithWorkspaces(t, [
    { id: numericId, meta: 'unsupported' },
  ]);

  const item = workspacePickItems(
    paths.listWorkspaceEntries(dir),
    undefined,
  )[0];

  assert.equal(item.label, 'Unidentified workspace');
  assert.equal(item.description, 'Workspace name unavailable');
});

test('numeric storageId with valid identity keeps the project name', async (t) => {
  const dir = await userDirWithWorkspaces(t, [
    { id: numericId, meta: { folder: 'file:///home/oshokin/real-project' } },
  ]);

  const listed = paths.listWorkspaceEntries(dir);

  assert.equal(paths.displayLabel(listed[0]), 'real-project (local)');
  const item = workspacePickItems(listed, undefined)[0];

  assert.match(item.label, /real-project/);
  assert.doesNotMatch(item.label, new RegExp(numericId));
  assert.equal(item.description, 'This computer');
  assert.equal(item.detail, '/home/oshokin/real-project');
});

test('export and import workspace pickers use different titles', () => {
  assert.equal(
    workspacePickTitle('export'),
    'Export chats — choose source workspace',
  );

  assert.equal(
    workspacePickTitle('import'),
    'Import chats — choose destination workspace',
  );

  assert.equal(workspacePickTitle('select'), 'Choose workspace');
  assert.notEqual(workspacePickTitle('export'), workspacePickTitle('import'));
});

test('Current is only set for a confirmed identity match', () => {
  const current: WorkspaceIdentity = {
    kind: 'folder',
    uri: uri('ssh-remote+host-a'),
  };

  const matched = entry('old', current);

  const other = entry('new', {
    kind: 'folder',
    uri: uri('ssh-remote+host-b'),
  });

  const items = workspacePickItems([other, matched], current);

  assert.equal(items[0].isCurrent, true);
  assert.equal(items[0].entry.storageId, 'old');
  assert.match(items[0].description, /^Current · /);
  assert.equal(items[1].isCurrent, false);
  assert.doesNotMatch(items[1].description, /^Current · /);
});

test('the newest unidentified folder is not treated as Current', () => {
  const items = workspacePickItems([entry(numericId)], {
    kind: 'folder',
    uri: uri('', '/tmp/open', 'file'),
  });

  assert.equal(items[0].isCurrent, false);
  assert.equal(items[0].label, 'Unidentified workspace');
});

test('same basename on different SSH authorities stay distinct pick rows', () => {
  const a = entry('a', { kind: 'folder', uri: uri('ssh-remote+host-a') });
  const b = entry('b', { kind: 'folder', uri: uri('ssh-remote+host-b') });
  const items = workspacePickItems([a, b], undefined);

  assert.equal(items.length, 2);
  assert.notEqual(items[0].entry.key, items[1].entry.key);
  assert.equal(items[0].description, 'SSH · host-a');
  assert.equal(items[1].description, 'SSH · host-b');
  assert.notEqual(items[0].description, items[1].description);
  assert.equal(items[0].detail, '/home/oshokin/project');
});

test('workspace pick items are a projection and do not mutate entries', () => {
  const original = entry(numericId);
  const snapshot = { ...original };

  workspacePickItems([original], undefined);
  assert.deepEqual(original, snapshot);
});

test('untitled chats use a UI fallback and keep the id off the primary label', () => {
  assert.equal(chatListLabel(undefined), 'Untitled chat');
  assert.equal(chatListLabel(''), 'Untitled chat');
  assert.equal(chatListLabel('   '), 'Untitled chat');

  const items = chatPickItems([
    { composerId: 'id-1', lastUpdatedAt: 5000 },
    { composerId: 'id-2', name: '  Починить SSH ✨  ', lastUpdatedAt: 1000 },
    { composerId: 'id-3', name: 'Older named', createdAt: 100 },
    { composerId: 'id-0' },
  ]);

  assert.deepEqual(
    items.map((item) => item.id),
    ['id-2', 'id-3', 'id-1', 'id-0'],
  );

  assert.equal(items[2].label, 'Untitled chat');
  assert.equal(items[2].detail, '');
  assert.match(items[2].description, /^Updated /);
  assert.equal(items[3].label, 'Untitled chat');
  assert.equal(items[3].description, 'Date unavailable');
  assert.equal(items[0].label, '  Починить SSH ✨  ');
  assert.equal(items[0].detail, '');
});

test('picker shows a decoded SSH host, not encoded authority', () => {
  const hex = Buffer.from(
    JSON.stringify({ hostName: 'oshokin-laptop' }),
  ).toString('hex');

  const item = workspacePickItems(
    [
      entry('id', {
        kind: 'folder',
        uri: {
          scheme: 'vscode-remote',
          authority: `ssh-remote%2B${hex}`,
          path: '/home/oshokin/projects/dispersed-object-store',
        },
      }),
    ],
    undefined,
  )[0];

  assert.equal(item.label, 'dispersed-object-store');
  assert.equal(item.description, 'SSH · oshokin-laptop');
  assert.equal(item.detail, '/home/oshokin/projects/dispersed-object-store');
  assert.doesNotMatch(item.description, /ssh-remote/i);
  assert.doesNotMatch(item.description, /%2B/i);
});

test('Current identifies the host storage rather than every generation of the same URI', () => {
  const identity: WorkspaceIdentity = {
    kind: 'folder',
    uri: uri('', '/repo/ordermanager', 'file'),
  };

  const old = {
    ...entry('old', identity),
    workspaceDbPath: '/storage/old/state.vscdb',
  };

  const active = {
    ...entry('active', identity),
    workspaceDbPath: '/storage/active/state.vscdb',
  };

  const items = workspacePickItems(
    [old, active],
    identity,
    active.workspaceDbPath,
  );

  assert.equal(items.length, 2);
  assert.equal(items.filter((item) => item.isCurrent).length, 1);
  assert.equal(items[0].entry.storageId, 'active');
});

test('ambiguous URI-only current identity never guesses a storage or merges rows', () => {
  const identity: WorkspaceIdentity = {
    kind: 'folder',
    uri: uri('', '/repo/ordermanager', 'file'),
  };

  const items = workspacePickItems(
    [entry('old', identity), entry('new', identity)],
    identity,
  );

  assert.equal(items.length, 2);
  assert.ok(items.every((item) => !item.isCurrent));
  assert.ok(items.every((item) => item.detail.includes('Storage')));
});
