import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatImportNotice,
  formatIncompleteExportNotice,
  notifyCompletion,
  phaseMessage,
  phaseProgress,
  resolveSelectedWorkspace,
} from '../src/operation-ui';
import type { ImportResult, WorkspaceEntry } from '../src/types';

/** Import result with test defaults, overridden per assertion. */
const result = (overrides: Partial<ImportResult>): ImportResult => ({
  imported: 0,
  complete: 0,
  historyOnly: 0,
  skipped: 0,
  alreadyImported: 0,
  alreadyPresent: 0,
  newVersions: 0,
  incomplete: 0,
  backups: null,
  composerIds: [],
  historyOnlyIds: [],
  skippedChats: [],
  alreadyImportedChats: [],
  newVersionChats: [],
  ...overrides,
});

test('already imported plus skipped chats is incomplete, without a restart', () => {
  const notice = formatImportNotice(result({ alreadyImported: 1, skipped: 1 }));
  assert.equal(notice.status, 'incomplete');
  assert.match(notice.detail, /1 chat was skipped/);
  assert.equal(notice.restart, false);
});

test('history-only updated copy remains incomplete', () => {
  const notice = formatImportNotice(
    result({ imported: 1, newVersions: 1, historyOnly: 1 }),
  );
  assert.equal(notice.status, 'incomplete');
  assert.match(notice.detail, /missing data/);
  assert.equal(notice.restart, true);
});

test('updated-copy notices agree in number and preserve the existing chat', () => {
  const plural = formatImportNotice(
    result({ imported: 2, newVersions: 2, complete: 2 }),
  );
  assert.equal(plural.title, 'Added 2 updated chat versions');
  assert.match(
    plural.detail,
    /Separate copies were created\. Your existing chats were kept/,
  );
  const singular = formatImportNotice(
    result({ imported: 1, newVersions: 1, complete: 1 }),
  );
  assert.match(
    singular.detail,
    /A separate copy was created\. Your existing chat was kept/,
  );
});

test('normal single import uses singular chat', () => {
  assert.equal(
    formatImportNotice(result({ imported: 1, complete: 1 })).title,
    'Imported 1 chat',
  );
});

test('restored copy uses restore wording and still asks to quit', () => {
  const notice = formatImportNotice(
    result({
      imported: 1,
      complete: 1,
      restored: 1,
      restoredChats: [
        { composerId: 'a', name: 'C++', reason: 'restored copy' },
      ],
    }),
  );
  assert.equal(notice.title, 'Restored 1 chat');
  assert.equal(
    notice.detail,
    'Quit Cursor and reopen it to load the restored chat.',
  );
  assert.equal(notice.restart, true);
  assert.match(notice.items[0] || '', /C\+\+ — restored copy/);
});

/** Workspace storage entry used as picker input. */
const entry = (storageId: string, root = '/tmp/a'): WorkspaceEntry => ({
  storageRoot: root,
  storageId,
  workspaceDbPath: `${root}/ws`,
  globalDbPath: `${root}/gl`,
  mtime: 0,
  key: storageId,
});

test('selected workspace is reused and a missing pair is not replaced', () => {
  const selected = entry('selected');
  const other = entry('other', '/tmp/b');
  assert.equal(
    resolveSelectedWorkspace(selected, [other, selected]).status,
    'ok',
  );
  assert.equal(resolveSelectedWorkspace(selected, [other]).status, 'missing');
  assert.equal(resolveSelectedWorkspace(undefined, [selected]).status, 'none');
});

test('completion notification does not have to be awaited', async () => {
  let seen: string | undefined;
  let started = false;
  notifyCompletion(
    () =>
      new Promise((resolve) => {
        started = true;
        setTimeout(() => resolve('Open log'), 20);
      }),
    (choice) => {
      seen = choice;
    },
    () => {
      seen = 'error';
    },
  );
  assert.equal(started, true);
  assert.equal(seen, undefined);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(seen, 'Open log');
});

test('import phases have visible labels before work finishes', () => {
  assert.match(phaseMessage('backup'), /backup/i);
  assert.match(phaseMessage('verify'), /verif/i);
  assert.match(phaseMessage('validate'), /validat/i);
  assert.match(phaseMessage('collect'), /dependenc/i);
  assert.match(
    phaseMessage('prepare', { processed: 2506, total: 3915 }),
    /2,506 \/ 3,915/,
  );
});

test('phase progress fills a determinate 0-100 range', () => {
  assert.equal(phaseProgress('export', 'collect'), 42);
  assert.equal(
    phaseProgress('export', 'collect', { processed: 1, total: 2 }),
    57,
  );
  assert.ok(
    phaseProgress('export', 'read', { processed: 2, total: 4 }) >
      phaseProgress('export', 'read', { processed: 1, total: 4 }),
  );
  assert.equal(phaseProgress('import', 'verify'), 93);
  assert.equal(
    phaseProgress('import', 'verify', { processed: 1, total: 1 }),
    100,
  );
});

test('incomplete export notice names one chat and truncates many', () => {
  const one = formatIncompleteExportNotice([
    {
      composerId: 'a',
      name: 'Fix SSH',
      reason: 'missing-body',
    },
  ]);
  assert.match(one.toast, /Fix SSH/);
  assert.match(one.toast, /no stored body/);
  const many = formatIncompleteExportNotice(
    [1, 2, 3, 4, 5].map((n) => ({
      composerId: String(n),
      name: `Chat ${n}`,
      reason: 'missing-dependencies' as const,
      missingBlobs: 2,
    })),
  );
  assert.match(many.toast, /Chat 1/);
  assert.match(many.toast, /Chat 3/);
  assert.match(many.toast, /2 more/);
  assert.doesNotMatch(many.toast, /Chat 5/);
});

test('incomplete export notice names a missing plan file', () => {
  const one = formatIncompleteExportNotice([
    {
      composerId: 'a',
      name: 'C++23 Hello World',
      reason: 'missing-dependencies',
      missingPlans: 1,
    },
  ]);
  assert.match(one.toast, /C\+\+23 Hello World/);
  assert.match(one.toast, /1 plan/);
});

test('formatImportNotice prefers a calm already-imported result', () => {
  const empty = {
    imported: 0,
    complete: 0,
    historyOnly: 0,
    skipped: 0,
    alreadyImported: 5,
    alreadyPresent: 5,
    newVersions: 0,
    incomplete: 0,
    backups: null,
    composerIds: [],
    historyOnlyIds: [],
    skippedChats: [],
    alreadyImportedChats: [{ composerId: 'a', name: 'Alpha' }],
    newVersionChats: [],
  };
  const skip = formatImportNotice(empty);
  assert.equal(skip.title, 'These chats are already imported');
  assert.equal(skip.restart, false);
  const mixed = formatImportNotice({
    ...empty,
    imported: 3,
    alreadyImported: 5,
    complete: 3,
  });
  assert.match(mixed.title, /Imported 3 chats · 5 already imported/);
  assert.equal(mixed.restart, true);
});

test('import toast mentions quit/reopen once when chats were written', () => {
  const written = formatImportNotice(result({ imported: 3, complete: 3 }));
  assert.equal(
    written.toast,
    'Imported 3 chats. Quit and reopen Cursor to load them.',
  );
  assert.equal((written.toast.match(/Quit and reopen/g) || []).length, 1);
  const already = formatImportNotice(result({ alreadyImported: 2 }));
  assert.equal(already.restart, false);
  assert.doesNotMatch(already.toast, /Quit and reopen/);
  assert.match(already.toast, /No changes made/);
});

test('incomplete export copy does not tell the user to reread chats', () => {
  const notice = formatIncompleteExportNotice([
    { composerId: 'a', name: 'Alpha', reason: 'missing-body' },
  ]);
  assert.doesNotMatch(notice.toast, /Quit and reopen/);
  assert.doesNotMatch(notice.toast, /Restart/);
});
