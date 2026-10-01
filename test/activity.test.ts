import test from 'node:test';
import assert from 'node:assert/strict';
import { chatActivity, recentChats, validTimestamp } from '../src/activity';
import { chatPickItems, workspacePickItems } from '../src/picker';
import type { ComposerHeader, WorkspaceEntry } from '../src/types';

/** Workspace storage entry used as picker input. */
function entry(
  id: string,
  scheme: string,
  authority: string,
  mtime: number,
): WorkspaceEntry {
  return {
    storageId: id,
    key: id,
    storageRoot: '/data',
    workspaceDbPath: '/ws',
    globalDbPath: '/gl',
    mtime,
    identity: { kind: 'folder', uri: { scheme, authority, path: '/same' } },
  };
}

test('chat order follows last activity, then creation, then ID; never input/SQL order', () => {
  const headers: ComposerHeader[] = [
    { composerId: 'unknown' },
    { composerId: 'old', createdAt: 100 },
    { composerId: 'new', createdAt: 300 },
    { composerId: 'continued', createdAt: 1, lastUpdatedAt: 400 },
    { composerId: 'tie-b', createdAt: 200 },
    { composerId: 'tie-a', createdAt: 200 },
  ];

  const before = structuredClone(headers);
  const expected = ['continued', 'new', 'tie-a', 'tie-b', 'old', 'unknown'];

  assert.deepEqual(
    recentChats(headers).map((h) => h.composerId),
    expected,
  );

  assert.deepEqual(
    recentChats([...headers].reverse()).map((h) => h.composerId),
    expected,
  );

  assert.deepEqual(headers, before);
});

test('invalid times fall back to creation; IDs and checkpoint timestamps are not dates', () => {
  for (const value of [
    undefined,
    null,
    '',
    '1790668800000',
    NaN,
    Infinity,
    -1,
    0,
    8.64e15 + 1,
  ]) {
    assert.equal(validTimestamp(value), 0);
  }

  assert.equal(
    chatActivity({
      composerId: '1790668800000',
      createdAt: 100,
      lastUpdatedAt: NaN,
    }),
    100,
  );

  assert.equal(
    chatActivity({
      composerId: '1790668800000',
      conversationCheckpointLastUpdatedAt: 900,
    }),
    0,
  );
});

test('chat picker keeps real names and archived/untitled chats, displays dates without unconditional UUID lines', () => {
  const items = chatPickItems([
    { composerId: 'old', createdAt: 1000, name: 'Older' },
    {
      composerId: 'new',
      lastUpdatedAt: 1790668800000,
      name: '  Real name  ',
      isArchived: true,
    },
    { composerId: 'unnamed' },
  ]);

  assert.deepEqual(
    items.map((item) => item.id),
    ['new', 'old', 'unnamed'],
  );

  assert.equal(items[0].label, '  Real name  ');
  assert.match(items[0].description, /^Updated /);
  assert.equal(items[2].description, 'Date unavailable');
  assert.equal(items[2].detail, '');
  assert.ok(items.every((item) => item.picked));
});

test('otherwise identical chat rows are disambiguated even when ID prefixes collide', () => {
  const rows = chatPickItems([
    { composerId: '12345678-a' },
    { composerId: '12345678-b' },
  ]);

  assert.notEqual(rows[0].description, rows[1].description);
  assert.match(rows[0].description, /12345678-a/);
});

test('workspace order is current, local, SSH, containers, WSL, remote, unidentified; recency within each group', () => {
  const entries = [
    entry('ssh-old', 'vscode-remote', 'ssh-remote+z', 10),
    entry('local-old', 'file', '', 10),
    entry('container', 'vscode-remote', 'dev-container+abc', 999),
    entry('ssh-new', 'vscode-remote', 'ssh-remote+a', 20),
    entry('local-new', 'file', '', 20),
    entry('current', 'vscode-remote', 'ssh-remote+current', 1),
    entry('wsl', 'vscode-remote', 'wsl+Ubuntu', 999),
    entry('other', 'custom', 'host', 999),
    { ...entry('unknown', 'file', '', 9999), identity: undefined },
  ];

  const before = structuredClone(entries);
  const rows = workspacePickItems(entries, entries[5].identity);

  assert.deepEqual(
    rows.map((row) => row.entry.storageId),
    [
      'current',
      'local-new',
      'local-old',
      'ssh-new',
      'ssh-old',
      'container',
      'wsl',
      'other',
      'unknown',
    ],
  );

  assert.deepEqual(entries, before);
});

test('container rows preserve distinct storage and encoded authority classification', () => {
  const rows = workspacePickItems(
    [
      entry('12345678-a', 'vscode-remote', 'dev-container%2Babc', 10),
      entry('12345678-b', 'vscode-remote', 'dev-container+def', 10),
    ],
    undefined,
  );

  assert.equal(rows.length, 2);
  assert.equal(rows[0].description, 'Container');
  assert.notEqual(rows[0].detail, rows[1].detail);
  assert.match(rows[0].detail, /12345678-a/);
});
