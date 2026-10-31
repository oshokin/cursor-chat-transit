import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { workspaceKey } from '../src/core';
import type { WorkspaceEntry, WorkspaceIdentity } from '../src/types';
import {
  annotateOpening,
  cursorFsPath,
  destinationStaysVisible,
  importStoragePrompt,
  openingStorageId,
  orderWorkspaceEntries,
  recheckDestination,
  retainOpeningContext,
  resolveAutomaticWorkspace,
  storageExplanation,
  storageMark,
} from '../src/workspace-opening';

const byblos = '/home/oshokin/go/src/gitlab.stageoffice.ru/UCS-SEARCH/byblos';

/** Minimal storage row. */
function entry(
  storageId: string,
  identity: WorkspaceIdentity | undefined,
  mtime: number,
  storageRoot = '/profile',
): WorkspaceEntry {
  return {
    storageRoot,
    storageId,
    workspaceDbPath: `/${storageRoot}/${storageId}/state.vscdb`,
    globalDbPath: `/${storageRoot}/global.vscdb`,
    mtime,
    identity,
    key: identity
      ? workspaceKey(identity.kind, identity.uri)
      : `id:${storageId}`,
  };
}

/** Local folder identity. */
function folder(filePath: string, scheme = 'file'): WorkspaceIdentity {
  return {
    kind: 'folder',
    uri: { scheme, authority: '', path: filePath, query: '', fragment: '' },
    sourceUri:
      scheme === 'file' ? `file://${filePath}` : `${scheme}://${filePath}`,
  };
}

test('Linux byblos id matches the folder path plus inode, with no separator', () => {
  const id = openingStorageId({
    platform: 'linux',
    kind: 'folder',
    scheme: 'file',
    hashed: byblos,
    stat: { ino: 38170113 },
  });

  assert.deepEqual(id, {
    status: 'id',
    id: 'd3f42da92a74a3cd4031654a3f20be9f',
  });
});

test('a different inode is a different id and does not add a zero salt', () => {
  const other = openingStorageId({
    platform: 'linux',
    kind: 'folder',
    scheme: 'file',
    hashed: byblos,
    stat: { ino: 1 },
  });

  const zero = openingStorageId({
    platform: 'linux',
    kind: 'folder',
    scheme: 'file',
    hashed: byblos,
    stat: { ino: 0 },
  });

  assert.deepEqual(other, {
    status: 'id',
    id: 'df0a6bb0bc03b6f56d5d165141c80ac1',
  });

  assert.deepEqual(zero, {
    status: 'id',
    id: '422249e8d323bd263e2d35a39c34960d',
  });

  assert.notEqual(
    other.status === 'id' ? other.id : '',
    zero.status === 'id' ? zero.id : '',
  );
});

test('macOS uses birthtime.getTime and Windows floors birthtimeMs', () => {
  const mac = openingStorageId({
    platform: 'darwin',
    kind: 'folder',
    scheme: 'file',
    hashed: '/tmp/App',
    stat: { birthtime: 1700000000123, birthtimeMs: 1700000000123.9 },
  });

  const windows = openingStorageId({
    platform: 'win32',
    kind: 'folder',
    scheme: 'file',
    hashed: 'C:\\Work\\App',
    stat: { birthtimeMs: 1700000000123.9, birthtime: 1700000000999 },
  });

  const fallback = openingStorageId({
    platform: 'win32',
    kind: 'folder',
    scheme: 'file',
    hashed: 'C:\\Work\\App',
    stat: { birthtime: 1700000000999 },
  });

  assert.deepEqual(mac, {
    status: 'id',
    id: '81cdf0241b577a2da089f08d6b6fa4a0',
  });

  assert.deepEqual(windows, {
    status: 'id',
    id: '80dfbf353a33bb93fae5e34a29c40a48',
  });

  assert.deepEqual(fallback, {
    status: 'id',
    id: '49b7bd93c38e7ff8b4ed53677a6db1e5',
  });
});

test('a missing or failed stat stays unknown', () => {
  for (const stat of [null, undefined] as const) {
    const id = openingStorageId({
      platform: 'linux',
      kind: 'folder',
      scheme: 'file',
      hashed: byblos,
      stat,
    });

    assert.deepEqual(id, { status: 'unknown', reason: 'stat-unavailable' });
  }
});

test('spaces, unicode, percent, and hash stay in the hashed path', () => {
  assert.deepEqual(
    openingStorageId({
      platform: 'linux',
      kind: 'folder',
      scheme: 'file',
      hashed: '/tmp/My Projects/byblos',
      stat: { ino: 9 },
    }),
    { status: 'id', id: 'a7b5012e8fd62dffaab2ba75488663ad' },
  );

  assert.deepEqual(
    openingStorageId({
      platform: 'linux',
      kind: 'folder',
      scheme: 'file',
      hashed: '/tmp/a#b',
      stat: { ino: 9 },
    }),
    { status: 'id', id: '8d7a85a9606ee369fdf963b43ddec45a' },
  );

  assert.deepEqual(
    openingStorageId({
      platform: 'linux',
      kind: 'folder',
      scheme: 'file',
      hashed: '/tmp/100%',
      stat: { ino: 9 },
    }),
    { status: 'id', id: '10a71f575dd8bf59e08c18eb442982ed' },
  );

  assert.deepEqual(
    openingStorageId({
      platform: 'linux',
      kind: 'folder',
      scheme: 'file',
      hashed: '/tmp/папка',
      stat: { ino: 9 },
    }),
    { status: 'id', id: 'e65308dfd6c30ab64fd210a7983fe1db' },
  );
});

test('Windows drive and UNC paths use fsPath, not a URL string', () => {
  assert.equal(
    cursorFsPath(
      { scheme: 'file', authority: '', path: '/C:/Work/App' },
      'win32',
    ),
    'c:\\Work\\App',
  );

  assert.equal(
    cursorFsPath(
      { scheme: 'file', authority: 'server', path: '/share/folder' },
      'win32',
    ),
    '\\\\server\\share\\folder',
  );

  assert.equal(
    cursorFsPath(
      {
        scheme: 'file',
        authority: 'server',
        path: '/share/project',
      },
      'linux',
    ),
    '//server/share/project',
  );
});

test('a lowercase Windows drive is the independent folder hash input', () => {
  assert.deepEqual(
    openingStorageId({
      platform: 'win32',
      kind: 'folder',
      scheme: 'file',
      hashed: 'c:\\Work\\App',
      stat: { birthtimeMs: 1700000000123.9 },
    }),
    { status: 'id', id: '1e03d7f65ade7a6fb6e8c47c74b8c7b2' },
  );
});

test('a remote folder hashes the original URI and does not stat', async () => {
  const remote = 'vscode-remote://ssh-remote%2Bhost/home/oshokin/byblos';

  assert.deepEqual(
    openingStorageId({
      platform: 'linux',
      kind: 'folder',
      scheme: 'vscode-remote',
      hashed: remote,
    }),
    { status: 'id', id: 'ce9835dcd66b42b74890174ca8718053' },
  );

  let stats = 0;

  const rows = await annotateOpening(
    [
      entry(
        'remote',
        {
          kind: 'folder',
          uri: {
            scheme: 'vscode-remote',
            authority: 'ssh-remote+host',
            path: '/home/oshokin/byblos',
            query: '',
            fragment: '',
          },
          sourceUri: remote,
        },
        1,
      ),
    ],
    {
      platform: 'linux',
      stat: async () => {
        stats += 1;

        return { ino: 1 };
      },
    },
  );

  assert.equal(stats, 0);
  assert.equal(rows[0].opening?.expectedId, 'ce9835dcd66b42b74890174ca8718053');
});

test('saved workspaces lowercase the path outside Linux', () => {
  const linux = openingStorageId({
    platform: 'linux',
    kind: 'workspace',
    scheme: 'file',
    hashed: '/home/oshokin/team.code-workspace',
  });

  const windows = openingStorageId({
    platform: 'win32',
    kind: 'workspace',
    scheme: 'file',
    hashed: 'C:\\Users\\Me\\Team.code-workspace',
  });

  assert.deepEqual(linux, {
    status: 'id',
    id: '21c948a13b28b94bb43ac875c495a81c',
  });

  assert.deepEqual(windows, {
    status: 'id',
    id: 'f999de56fcd0db928e80108ed88c1ae5',
  });
});

test('untitled and an unknown host are not guessed from mtime', () => {
  assert.deepEqual(
    openingStorageId({
      platform: 'linux',
      kind: 'folder',
      scheme: 'untitled',
      hashed: 'untitled:1',
      stat: { ino: 9 },
    }),
    { status: 'unknown', reason: 'untitled' },
  );
});

test('expected storage stays first even when another row has a newer WAL', () => {
  const identity = folder(byblos);

  const expected = {
    ...entry('d3f42da92a74a3cd4031654a3f20be9f', identity, 10),
    opening: {
      expectedId: 'd3f42da92a74a3cd4031654a3f20be9f',
      duplicate: true,
    },
  };

  const other = {
    ...entry('e8efa053eec9a5285a9bfe79eab0da1e', identity, 30),
    opening: {
      expectedId: 'd3f42da92a74a3cd4031654a3f20be9f',
      duplicate: true,
    },
  };

  for (const mode of ['name', 'activity'] as const) {
    const ordered = orderWorkspaceEntries([other, expected], { mode });

    assert.deepEqual(
      ordered.map((row) => row.storageId),
      ['d3f42da92a74a3cd4031654a3f20be9f', 'e8efa053eec9a5285a9bfe79eab0da1e'],
    );
  }
});

test('the A/B/C activity cycle is the same for every input order', () => {
  const x = folder('/x');
  const y = folder('/y');

  const a = {
    ...entry('a', x, 10),
    opening: { expectedId: 'a', duplicate: true },
  };

  const b = {
    ...entry('b', x, 30),
    opening: { expectedId: 'a', duplicate: true },
  };

  const c = entry('c', y, 20);

  const inputs = [a, b, c].flatMap((first, index, rows) =>
    rows
      .filter((_row, second) => second !== index)
      .map((second) => [
        first,
        second,
        rows.find((row) => row !== first && row !== second)!,
      ]),
  );

  for (const input of inputs) {
    assert.deepEqual(
      orderWorkspaceEntries(input, { mode: 'activity' }).map(
        (row) => row.storageId,
      ),
      ['a', 'b', 'c'],
    );
  }
});

test('the same SSH name lists the newer host before an older authority', () => {
  const ssh = (authority: string, storageId: string, mtime: number) =>
    entry(
      storageId,
      {
        kind: 'folder',
        uri: {
          scheme: 'vscode-remote',
          authority,
          path: '/work/app',
          query: '',
          fragment: '',
        },
      },
      mtime,
    );

  const ordered = orderWorkspaceEntries(
    [ssh('ssh-remote+aaa', 'old', 10), ssh('ssh-remote+zzz', 'fresh', 100)],
    { mode: 'name' },
  );

  assert.deepEqual(
    ordered.map((row) => row.storageId),
    ['fresh', 'old'],
  );
});

test('a one-row reread keeps the duplicate flag from the full inventory', () => {
  const prepared = {
    ...entry('older', folder('/repo'), 1),
    opening: { expectedId: 'older', duplicate: true },
  };

  const fresh = {
    ...prepared,
    opening: { expectedId: 'older', duplicate: false },
  };

  const kept = retainOpeningContext(prepared, fresh);

  assert.equal(kept.opening?.duplicate, true);
  assert.equal(storageMark(kept, false), 'Opens with this folder');

  const singleton = {
    ...entry('only', folder('/only'), 1),
    opening: { expectedId: 'only', duplicate: false },
  };

  assert.equal(
    storageMark(retainOpeningContext(singleton, { ...singleton }), false),
    undefined,
  );
});

test('local and SSH names stay in different groups, as do two local paths', () => {
  const local = entry('local', folder('/work/byblos'), 1);

  const ssh = entry(
    'ssh',
    {
      kind: 'folder',
      uri: {
        scheme: 'vscode-remote',
        authority: 'ssh-remote+host',
        path: '/work/byblos',
        query: '',
        fragment: '',
      },
    },
    100,
  );

  const otherDir = entry('other', folder('/elsewhere/byblos'), 100);

  const ordered = orderWorkspaceEntries([ssh, otherDir, local], {
    mode: 'name',
  });

  assert.deepEqual(
    ordered.map((row) => row.storageId),
    ['other', 'local', 'ssh'],
  );
});

test('invalid timestamps stay in a defined order', () => {
  const left = entry('a', folder('/a/project'), Number.NaN);
  const right = entry('b', folder('/b/project'), Number.POSITIVE_INFINITY);

  const forward = orderWorkspaceEntries([left, right], { mode: 'name' }).map(
    (row) => row.storageId,
  );

  const backward = orderWorkspaceEntries([right, left], { mode: 'name' }).map(
    (row) => row.storageId,
  );

  assert.deepEqual(forward, ['a', 'b']);
  assert.deepEqual(backward, forward);
});

test('a row without identity is its own group', () => {
  const bare = entry('bare', undefined, 1);
  const named = entry('named', folder('/a'), 1);
  const ordered = orderWorkspaceEntries([bare, named], { mode: 'name' });

  assert.equal(ordered.length, 2);
  assert.ok(ordered.some((row) => row.storageId === 'bare'));
});

test('a pinned current group still lists the expected storage first', () => {
  const identity = folder('/repo');

  const expected = {
    ...entry('expected', identity, 1),
    opening: { expectedId: 'expected', duplicate: true },
  };

  const current = {
    ...entry('current', identity, 50),
    opening: { expectedId: 'expected', duplicate: true },
  };

  const ordered = orderWorkspaceEntries([current, expected], {
    mode: 'activity',
    current: identity,
    currentDatabase: current.workspaceDbPath,
  });

  assert.deepEqual(
    ordered.map((row) => row.storageId),
    ['expected', 'current'],
  );
});

test('automatic selection uses the physical database, then an existing expected id', () => {
  const identity = folder('/repo');

  const older = {
    ...entry('older', identity, 50),
    opening: { expectedId: 'newer', duplicate: true },
  };

  const newer = {
    ...entry('newer', identity, 1),
    opening: { expectedId: 'newer', duplicate: true },
  };

  assert.equal(
    resolveAutomaticWorkspace([older, newer], older.workspaceDbPath, identity)
      ?.storageId,
    'older',
  );

  assert.equal(
    resolveAutomaticWorkspace([older, newer], undefined, identity)?.storageId,
    'newer',
  );

  assert.equal(
    resolveAutomaticWorkspace(
      [{ ...older, opening: undefined }],
      undefined,
      identity,
    ),
    undefined,
  );
});

test('the same URI in two profiles stays two selections', () => {
  const identity = folder('/repo');
  const left = entry('same', identity, 1, '/profile-a');
  const right = entry('same', identity, 2, '/profile-b');
  const ordered = orderWorkspaceEntries([right, left], { mode: 'activity' });

  assert.deepEqual(
    ordered.map((row) => row.storageRoot),
    ['/profile-b', '/profile-a'],
  );
});

test('labels keep current and expected distinct, including a single mismatch', () => {
  const identity = folder('/repo');

  const current = {
    ...entry('current', identity, 1),
    opening: { expectedId: 'expected', duplicate: true },
  };

  const expected = {
    ...entry('expected', identity, 1),
    opening: { expectedId: 'expected', duplicate: true },
  };

  const alone = {
    ...entry('older', identity, 1),
    opening: { expectedId: 'missing', duplicate: false },
  };

  assert.equal(storageMark(current, true), 'Current window');
  assert.match(storageExplanation(current, true) || '', /different storage/);
  assert.equal(storageMark(expected, false), 'Opens with this folder');

  assert.match(
    storageExplanation(expected, false) || '',
    /Cursor uses this storage when opening this folder/,
  );

  assert.equal(storageMark(alone, false), 'Other storage');

  assert.match(storageExplanation(alone, false) || '', /separate chat history/);
});

test('import asks before writing to other storage and does not invent a directory', () => {
  const identity = folder('/repo');

  const selected = {
    ...entry('older', identity, 1),
    opening: { expectedId: 'newer', duplicate: true },
  };

  const expected = {
    ...entry('newer', identity, 1),
    opening: { expectedId: 'newer', duplicate: true },
  };

  const prompt = importStoragePrompt(selected, [selected, expected]);

  assert.equal(prompt.kind, 'switch');

  if (prompt.kind === 'switch') {
    assert.equal(prompt.useLabel, 'Use Folder Storage');
    assert.equal(prompt.expected.storageId, 'newer');
    assert.match(prompt.message, /folder’s storage/);
  }

  const missing = importStoragePrompt(selected, [selected]);

  assert.equal(missing.kind, 'missing');
  assert.equal(importStoragePrompt(expected, [selected, expected]).kind, 'ok');

  const workspaceIdentity: WorkspaceIdentity = {
    kind: 'workspace',
    uri: identity.uri,
  };

  const workspaceRow = {
    ...entry('older', workspaceIdentity, 1),
    opening: { expectedId: 'newer', duplicate: true },
  };

  const workspaceExpected = {
    ...entry('newer', workspaceIdentity, 1),
    opening: { expectedId: 'newer', duplicate: true },
  };

  const workspacePrompt = importStoragePrompt(workspaceRow, [
    workspaceRow,
    workspaceExpected,
  ]);

  assert.equal(workspacePrompt.kind, 'switch');

  if (workspacePrompt.kind === 'switch')
    assert.equal(workspacePrompt.useLabel, 'Use Workspace Storage');
});

test('an unverified duplicate and an empty expected row keep their own marks', () => {
  const identity = folder('/repo');

  const unverified = {
    ...entry('a', identity, 1),
    opening: { duplicate: true, reason: 'stat-unavailable' as const },
  };

  const expected = {
    ...entry('b', identity, 0),
    opening: { expectedId: 'b', duplicate: true },
  };

  assert.equal(storageMark(unverified, false), 'Storage not verified');
  assert.equal(destinationStaysVisible(expected, false), true);
  assert.equal(destinationStaysVisible(unverified, false), false);
  assert.equal(importStoragePrompt(unverified, [unverified]).kind, 'ok');
});

test('a denied stat stays unknown and does not label an expected storage', async () => {
  const rows = await annotateOpening([entry('old', folder('/gone'), 5)], {
    platform: 'linux',
    stat: async () => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    },
  });

  assert.equal(rows[0].opening?.expectedId, undefined);
  assert.equal(rows[0].opening?.reason, 'stat-unavailable');
  assert.equal(storageMark(rows[0], false), undefined);
});

test('a vanished or recreated destination stops instead of changing the target', () => {
  const identity = folder('/repo');

  const chosen = {
    ...entry('older', identity, 1),
    opening: { expectedId: 'older', duplicate: false },
  };

  const recreated = {
    ...chosen,
    opening: { expectedId: 'brand-new', duplicate: false },
  };

  assert.equal(recheckDestination(chosen, [], false).status, 'stop');
  assert.equal(recheckDestination(chosen, [recreated], false).status, 'stop');

  const kept = recheckDestination(chosen, [recreated], true);

  assert.equal(kept.status, 'stop');

  const moved = {
    ...chosen,
    identity: folder('/other'),
    opening: { reason: 'stat-unavailable' as const, duplicate: true },
  };

  const chosenUnknown = {
    ...chosen,
    opening: { reason: 'stat-unavailable' as const, duplicate: true },
  };

  assert.equal(recheckDestination(chosenUnknown, [moved], true).status, 'stop');
});

test('one snapshot stats each local folder once and issues no SQL', async () => {
  const calls: string[] = [];

  const rows = await annotateOpening(
    [
      entry('one', folder('/work/app'), 1),
      entry('two', folder('/work/app'), 2),
      entry('three', folder('/work/other'), 3),
    ],
    {
      platform: 'linux',
      stat: async (file) => {
        calls.push(file);

        return { ino: file.endsWith('other') ? 2 : 38170113 };
      },
    },
  );

  assert.deepEqual(calls.sort(), ['/work/app', '/work/other']);
  assert.equal(rows[0].opening?.expectedId, rows[1].opening?.expectedId);
  assert.equal(rows[0].opening?.duplicate, true);
  assert.notEqual(rows[2].opening?.expectedId, rows[0].opening?.expectedId);
});

test('sorting a large list does not search the list inside each comparison', () => {
  const rows = Array.from({ length: 2000 }, (_value, index) =>
    entry(`id-${index}`, folder(`/work/${index % 50}`), index),
  );

  const ordered = orderWorkspaceEntries(rows, { mode: 'name' });

  assert.equal(ordered.length, 2000);

  const firstGroup = ordered
    .filter((row) => row.identity?.uri.path === ordered[0].identity?.uri.path)
    .map((row) => row.storageId);

  const again = orderWorkspaceEntries([...rows].reverse(), { mode: 'name' })
    .filter((row) => row.identity?.uri.path === ordered[0].identity?.uri.path)
    .map((row) => row.storageId);

  assert.deepEqual(firstGroup, again);
});

test('the Manage chats menu has a native mutually exclusive sort submenu', () => {
  const manifest = JSON.parse(
    readFileSync(path.join(__dirname, '../package.json'), 'utf8'),
  );

  assert.deepEqual(manifest.contributes.submenus, [
    {
      id: 'cursorChatTransit.manageSortWorkspaces',
      label: 'Sort workspaces',
    },
  ]);

  const titleSort = manifest.contributes.menus['view/title'].filter(
    (item: { submenu?: string }) =>
      item.submenu === 'cursorChatTransit.manageSortWorkspaces',
  );

  assert.deepEqual(titleSort, [
    {
      submenu: 'cursorChatTransit.manageSortWorkspaces',
      when: 'view == cursorChatTransit.manage',
      group: '1_overflow@2',
    },
  ]);

  assert.deepEqual(
    manifest.contributes.menus['cursorChatTransit.manageSortWorkspaces'],
    [
      {
        command: 'cursorChatTransit.manageSortNameCurrent',
        when: 'cursorChatTransit.manageWorkspaceSort == name',
        group: '1_sort@1',
      },
      {
        command: 'cursorChatTransit.manageSortName',
        when: 'cursorChatTransit.manageWorkspaceSort != name',
        group: '1_sort@1',
      },
      {
        command: 'cursorChatTransit.manageSortRecentCurrent',
        when: 'cursorChatTransit.manageWorkspaceSort == recent',
        group: '1_sort@2',
      },
      {
        command: 'cursorChatTransit.manageSortRecent',
        when: 'cursorChatTransit.manageWorkspaceSort != recent',
        group: '1_sort@2',
      },
    ],
  );

  const commands = new Map(
    manifest.contributes.commands.map(
      (command: { command: string; title: string }) => [
        command.command,
        command.title,
      ],
    ),
  );

  assert.equal(commands.get('cursorChatTransit.manageSortName'), 'Name (A–Z)');

  assert.equal(
    commands.get('cursorChatTransit.manageSortNameCurrent'),
    '✓ Name (A–Z)',
  );

  assert.equal(
    commands.get('cursorChatTransit.manageSortRecent'),
    'Recent activity',
  );

  assert.equal(
    commands.get('cursorChatTransit.manageSortRecentCurrent'),
    '✓ Recent activity',
  );
});
