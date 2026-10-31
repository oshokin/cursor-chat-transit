import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ManagedNode } from '../src/managed-node';
import {
  confirmationCopy,
  describeManagedResult,
  requestsFromNodes,
  selectionSummary,
  storageLabel,
} from '../src/managed-delete-plan';
import { ManagedSelection } from '../src/managed-selection';
import type { WorkspaceEntry } from '../src/types';

function entry(id: string, name: string): WorkspaceEntry {
  return {
    storageRoot: '/profile',
    storageId: id,
    workspaceDbPath: `/profile/User/workspaceStorage/${id}/state.vscdb`,
    globalDbPath: '/profile/User/globalStorage/state.vscdb',
    mtime: 0,
    key: id,
    identity: {
      kind: 'folder',
      uri: { scheme: 'file', authority: '', path: `/projects/${name}` },
    },
  };
}

const one = entry('7fa132ab-full', 'ordermanager');
const two = entry('91572d11-full', 'old-demo');

test('root selection stays workspace-data, including a root with no loaded children', () => {
  const requests = requestsFromNodes([{ workspace: one }]);

  assert.deepEqual(requests, [{ kind: 'workspace-data', workspace: one }]);
});

test('one chat stays chat-only and does not delete workspace data', () => {
  const requests = requestsFromNodes([
    { workspace: one, chat: { composerId: 'a' } },
  ]);

  assert.deepEqual(requests, [{ kind: 'chats', workspace: one, ids: ['a'] }]);
});

test('a selected root covers its children without duplicating them', () => {
  const requests = requestsFromNodes([
    { workspace: one },
    { workspace: one, chat: { composerId: 'a' } },
  ]);

  assert.deepEqual(requests, [{ kind: 'workspace-data', workspace: one }]);
});

test('checking every child manually stays chat-only', () => {
  const requests = requestsFromNodes([
    { workspace: one, chat: { composerId: 'a' } },
    { workspace: one, chat: { composerId: 'b' } },
  ]);

  assert.deepEqual(requests, [
    { kind: 'chats', workspace: one, ids: ['a', 'b'] },
  ]);
});

test('two storages with the same project name stay separate', () => {
  const other = entry('bbbbbbbb-full', 'ordermanager');

  const requests = requestsFromNodes([
    { workspace: one },
    { workspace: other },
  ]);

  assert.deepEqual(
    requests.map((request) => request.workspace.storageId),
    ['7fa132ab-full', 'bbbbbbbb-full'],
  );
});

test('mixed selection counts workspace chats separately from individual chats', () => {
  const nodes: ManagedNode[] = [
    { workspace: one },
    { workspace: two, chat: { composerId: 'a' } },
    { workspace: two, chat: { composerId: 'b' } },
    { workspace: two, chat: { composerId: 'c' } },
  ];

  assert.equal(
    selectionSummary(nodes),
    '1 workspace + 3 individual chats selected',
  );

  assert.match(selectionSummary([], 0), /Project files are kept/);
  assert.match(selectionSummary(nodes, 1), /1 selected workspace is hidden/);
});

test('storage prefixes that collide are shown in full', () => {
  assert.equal(storageLabel('7fa132ab-full', ['7fa132ab-full']), '7fa132ab…');

  assert.equal(
    storageLabel('7fa132ab-full', ['7fa132ab-full', '7fa132ab-other']),
    '7fa132ab-full',
  );
});

test('one workspace confirmation names workspace data and keeps project files', () => {
  const copy = confirmationCopy({
    userDataRoot: '/profile',
    targets: [
      {
        kind: 'workspace-data',
        workspace: one,
        ids: ['a'],
        token: 't',
        name: 'ordermanager',
        location: 'This computer',
        pathLabel: '/home/oleg/projects/ordermanager',
      },
    ],
  });

  assert.equal(copy.title, 'Delete workspace data for “ordermanager”?');
  assert.equal(copy.confirm, 'Delete workspace data');
  assert.match(copy.detail, /Project files are kept/);
  assert.match(copy.detail, /local resources and extension data/);
});

test('an empty workspace confirmation does not claim there were chats', () => {
  const copy = confirmationCopy({
    userDataRoot: '/profile',
    targets: [
      {
        kind: 'workspace-data',
        workspace: two,
        ids: [],
        token: 't',
        name: 'old-demo',
        location: 'This computer',
        pathLabel: '/tmp/old-demo',
      },
    ],
  });

  assert.match(copy.detail, /No chat history was found/);

  assert.equal(
    describeManagedResult({
      outcomes: [
        {
          kind: 'workspace-data',
          workspaceKey: two.workspaceDbPath,
          label: 'old-demo',
          chatIdsDeleted: [],
          chatIdsSkipped: [],
          storage: 'deleted',
        },
      ],
    }),
    'Deleted data for “old-demo”. No chat records were deleted. Project files were kept.',
  );
});

test('the manifest shows one trash action per row state', () => {
  const manifest = JSON.parse(
    readFileSync(path.join(__dirname, '../package.json'), 'utf8'),
  ) as {
    contributes: {
      menus: {
        'view/item/context': {
          command: string;
          when: string;
          group?: string;
        }[];
      };
    };
  };

  const trash = manifest.contributes.menus['view/item/context'].filter(
    (item) => item.group === 'inline@3',
  );

  assert.deepEqual(
    trash.map((item) => item.command),
    [
      'cursorChatTransit.manageDelete',
      'cursorChatTransit.manageDeleteItem',
      'cursorChatTransit.manageDeleteWorkspaceData',
    ],
  );

  assert.match(trash[1].when, /managedChat/);
  assert.match(trash[2].when, /managedWorkspace/);
  assert.doesNotMatch(trash[2].when, /managedCurrentWorkspace/);
});

test('unknown, skipped, and failed results are not described as deleted', () => {
  assert.doesNotMatch(
    describeManagedResult({
      outcomes: [
        {
          kind: 'workspace-data',
          workspaceKey: 'a',
          label: 'A',
          chatIdsDeleted: [],
          chatIdsSkipped: [],
          storage: 'unknown',
          errorMessage: 'Workspace data was already gone.',
        },
      ],
    }),
    /^Deleted data/,
  );

  assert.match(
    describeManagedResult({
      outcomes: [
        {
          kind: 'chats',
          workspaceKey: 'a',
          label: 'A',
          chatIdsDeleted: ['deleted'],
          chatIdsSkipped: ['kept'],
          storage: 'not-requested',
        },
      ],
    }),
    /1 chat skipped/i,
  );

  assert.doesNotMatch(
    describeManagedResult({
      error: 'SQL failure',
      outcomes: [
        {
          kind: 'chats',
          workspaceKey: 'a',
          label: 'A',
          chatIdsDeleted: [],
          chatIdsSkipped: [],
          storage: 'not-requested',
          errorMessage: 'SQL failure',
        },
      ],
    }),
    /^Deleted data/,
  );
});

test('select empty keeps requireEmpty and a manual check does not', () => {
  const automatic = requestsFromNodes([{ workspace: two, requireEmpty: true }]);

  assert.equal(automatic[0]?.kind, 'workspace-data');
  if (automatic[0]?.kind !== 'workspace-data') return;
  assert.equal(automatic[0].requireEmpty, true);

  const manual = requestsFromNodes([{ workspace: two }]);

  assert.equal(manual[0]?.kind, 'workspace-data');
  if (manual[0]?.kind !== 'workspace-data') return;
  assert.equal(manual[0].requireEmpty, undefined);

  const selection = new ManagedSelection();
  const revision = selection.revision;

  selection.selectWorkspaces([{ workspace: two, requireEmpty: true }]);
  assert.notEqual(selection.revision, revision);
  assert.equal(selection.values()[0]?.requireEmpty, true);
  selection.set({ workspace: two }, true);
  assert.equal(selection.values()[0]?.requireEmpty, undefined);
});

test('an empty-only plan uses the empty-history confirmation', () => {
  const copy = confirmationCopy({
    userDataRoot: '/profile',
    targets: [
      {
        kind: 'workspace-data',
        workspace: one,
        ids: [],
        token: 't',
        name: 'ordermanager',
        location: 'This computer',
        pathLabel: '/home/oleg/projects/ordermanager',
        requireEmpty: true,
      },
      {
        kind: 'workspace-data',
        workspace: two,
        ids: ['shell'],
        token: 't',
        name: 'old-demo',
        location: 'This computer',
        pathLabel: '/tmp/old-demo',
        requireEmpty: true,
      },
    ],
  });

  assert.equal(
    copy.title,
    'Delete data for 2 workspaces with no chat history?',
  );

  assert.equal(copy.confirm, 'Delete workspace data');
  assert.match(copy.detail, /No chat history was found/);
  assert.match(copy.detail, /1 empty chat record/);
  assert.doesNotMatch(copy.detail, /Individual chats/);
});

test('the toolbar keeps one visibility slot, moves refresh to the overflow menu, and registers select empty once', () => {
  const manifest = JSON.parse(
    readFileSync(path.join(__dirname, '../package.json'), 'utf8'),
  ) as {
    contributes: {
      commands: { command: string }[];
      menus: {
        'view/title': { command: string; group: string }[];
        commandPalette: { command: string; when: string }[];
      };
    };
  };

  const commands = manifest.contributes.commands.filter(
    (command) => command.command === 'cursorChatTransit.manageSelectEmpty',
  );

  assert.equal(commands.length, 1);

  const title = manifest.contributes.menus['view/title'];

  const group = (command: string) =>
    title.filter((item) => item.command === command).map((item) => item.group);

  assert.deepEqual(group('cursorChatTransit.manageRefresh'), ['1_overflow@1']);
  assert.deepEqual(group('cursorChatTransit.manageShowAll'), ['navigation@2']);

  assert.deepEqual(group('cursorChatTransit.manageShowRemovable'), [
    'navigation@2',
  ]);

  assert.deepEqual(group('cursorChatTransit.manageSelectEmpty'), [
    'navigation@3',
  ]);

  assert.deepEqual(group('cursorChatTransit.manageSelectAll'), [
    'navigation@4',
  ]);

  assert.deepEqual(group('cursorChatTransit.manageClearSelection'), [
    'navigation@4',
  ]);

  assert.deepEqual(group('cursorChatTransit.manageExportSelected'), [
    'navigation@6',
  ]);

  assert.deepEqual(group('cursorChatTransit.manageDelete'), ['navigation@7']);

  assert.equal(
    manifest.contributes.menus.commandPalette.filter(
      (item) => item.command === 'cursorChatTransit.manageSelectEmpty',
    ).length,
    1,
  );
});
