import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sqlText } from '../src/core';
import { countOwnershipReads } from '../src/deletion-ownership';
import { listWorkspaceChats } from '../src/export-transfer';
import {
  executeManagedDelete,
  findEmptyWorkspaces,
  prepareManagedDelete,
} from '../src/managed-delete-run';
import { MAX_SQLITE_VALUE_BYTES } from '../src/bundle-limits';
import {
  ensureInitFile,
  execSqlScript,
  findSqliteExecutable,
} from '../src/sqlite';
import { runStatistics } from '../src/statistics';
import { SqliteSession } from '../src/sqlite-session';
import { observeTransfer } from '../src/transfer-events';
import type { TransferContext, WorkspaceEntry } from '../src/types';
import { assessWorkspaceHistory } from '../src/workspace-history';
import { withDirectoryRemoval } from '../src/workspace-removal';
import { allowAccess, denyAccess } from './access';

const executable = findSqliteExecutable(process.env.SQLITE3_PATH);
const skip = executable ? false : 'sqlite3 required';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const D = '44444444-4444-4444-8444-444444444444';

/** One temporary profile and a way to add workspace directories to it. */
async function profile(): Promise<{
  root: string;
  ctx: TransferContext;
  globalDbPath: string;
  add: (
    storageId: string,
    ids: string[],
    rows?: Array<[string, string]>,
    composer?: string,
  ) => Promise<WorkspaceEntry>;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cct-empty-'));

  const ctx: TransferContext = {
    executable: executable!,
    initFile: await ensureInitFile(root),
  };

  const globalDbPath = path.join(root, 'User', 'globalStorage', 'state.vscdb');

  await mkdir(path.dirname(globalDbPath), { recursive: true });

  await execSqlScript({
    ...ctx,
    database: globalDbPath,
    sql: `PRAGMA journal_mode=WAL; CREATE TABLE ItemTable(key TEXT PRIMARY KEY, value BLOB); CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY, value BLOB);`,
  });

  const headers: Array<{
    composerId: string;
    workspaceIdentifier: { id: string };
  }> = [];

  return {
    root,
    ctx,
    globalDbPath,
    add: async (storageId, ids, rows = [], composer) => {
      const directory = path.join(root, 'User', 'workspaceStorage', storageId);
      const workspaceDbPath = path.join(directory, 'state.vscdb');

      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, 'extension-state.txt'), storageId);

      await execSqlScript({
        ...ctx,
        database: workspaceDbPath,
        sql: `PRAGMA journal_mode=WAL; CREATE TABLE ItemTable(key TEXT PRIMARY KEY, value BLOB); INSERT INTO ItemTable VALUES ('composer.composerData',${sqlText(
          JSON.stringify({
            selectedComposerIds: ids,
            lastFocusedComposerIds: ids,
          }),
        )});`,
      });

      for (const id of ids)
        headers.push({
          composerId: id,
          workspaceIdentifier: { id: storageId },
        });

      const kv = [
        ...(composer === ''
          ? []
          : ids.map(
              (id) =>
                `('composerData:${id}',${sqlText(composer === undefined ? '{}' : composer)})`,
            )),
        ...rows.map(([key, value]) => `(${sqlText(key)},${sqlText(value)})`),
      ];

      await execSqlScript({
        ...ctx,
        database: globalDbPath,
        sql: `INSERT OR REPLACE INTO ItemTable VALUES ('composer.composerHeaders',${sqlText(
          JSON.stringify({ allComposers: headers }),
        )});${kv.length ? ` INSERT OR REPLACE INTO cursorDiskKV VALUES ${kv.join(',')};` : ''}`,
      });

      return {
        storageRoot: root,
        storageId,
        key: storageId,
        mtime: 0,
        globalDbPath,
        workspaceDbPath,
        identity: {
          kind: 'folder',
          uri: {
            scheme: 'file',
            authority: '',
            path: path.join(root, 'projects', storageId),
          },
        },
      };
    },
  };
}

test(
  'supported indexes with no chats are empty, including a known shell id',
  { skip },
  async () => {
    const { root, ctx, add } = await profile();

    try {
      const empty = await add('empty', []);
      const shell = await add('shell', [A]);

      assert.equal((await assessWorkspaceHistory(ctx, empty)).state, 'empty');
      assert.deepEqual((await assessWorkspaceHistory(ctx, shell)).ids, [A]);
      assert.equal((await assessWorkspaceHistory(ctx, shell)).state, 'empty');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'untitled, archived, assistant, preview, and selected history are not empty',
  { skip },
  async () => {
    const { root, ctx, add } = await profile();

    try {
      const untitled = await add(
        'untitled',
        [A],
        [[`bubbleId:${A}:m`, '{"type":"user","text":"hello"}']],
        JSON.stringify({ name: 'Untitled' }),
      );

      const archived = await add(
        'archived',
        [B],
        [[`bubbleId:${B}:m`, '{"type":"user","text":"old"}']],
        JSON.stringify({ archived: true }),
      );

      const assistant = await add(
        'assistant',
        [C],
        [[`bubbleId:${C}:m`, '{"type":"assistant","text":"done"}']],
      );

      const preview = await add(
        'preview',
        [D],
        [],
        JSON.stringify({
          fullConversationHeadersOnly: [{ grouping: { textPreview: 'kept' } }],
        }),
      );

      assert.equal(
        (await assessWorkspaceHistory(ctx, untitled)).state,
        'present',
      );

      assert.equal(
        (await assessWorkspaceHistory(ctx, archived)).state,
        'present',
      );

      assert.equal(
        (await assessWorkspaceHistory(ctx, assistant)).state,
        'present',
      );

      assert.notEqual(
        (await assessWorkspaceHistory(ctx, preview)).state,
        'empty',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'an orphan bubble is history and a missing composer row is empty',
  { skip },
  async () => {
    const { root, ctx, add } = await profile();

    try {
      const orphan = await add('orphan', [A], [[`bubbleId:${A}:m`, '{}']], '');
      const missing = await add('missing', [B], [], '');

      const mixed = await add(
        'mixed',
        [C, D],
        [[`bubbleId:${D}:m`, '{"type":"user","text":"kept"}']],
        '',
      );

      assert.equal(
        (await assessWorkspaceHistory(ctx, orphan)).state,
        'present',
      );

      assert.equal((await assessWorkspaceHistory(ctx, missing)).state, 'empty');
      assert.equal((await assessWorkspaceHistory(ctx, mixed)).state, 'present');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'a blank conversation state is empty and one bad id does not hide a chat',
  { skip },
  async () => {
    const blankProfile = await profile();

    try {
      const blank = await blankProfile.add(
        'blank',
        [A],
        [],
        JSON.stringify({
          _v: 11,
          conversationState: '',
          text: '',
          fullConversationHeadersOnly: [],
        }),
      );

      assert.equal(
        (await assessWorkspaceHistory(blankProfile.ctx, blank)).state,
        'empty',
      );
    } finally {
      await rm(blankProfile.root, { recursive: true, force: true });
    }

    const badProfile = await profile();

    try {
      const alone = await badProfile.add('alone', ['task-tool_not-a-uuid']);

      const listed = await badProfile.add(
        'listed',
        ['task-tool_not-a-uuid', B],
        [[`bubbleId:${B}:m`, '{"type":"user","text":"kept"}']],
      );

      assert.equal(
        (await assessWorkspaceHistory(badProfile.ctx, alone)).state,
        'unknown',
      );

      assert.equal(
        (await assessWorkspaceHistory(badProfile.ctx, listed)).state,
        'present',
      );
    } finally {
      await rm(badProfile.root, { recursive: true, force: true });
    }
  },
);

test(
  'listed header-only chats are selected as empty and an unreadable sibling stays unchecked',
  { skip },
  async () => {
    const { root, ctx, add } = await profile();

    try {
      const missing = await add('missing', [A], [], '');

      const blank = await add(
        'blank',
        [B],
        [],
        JSON.stringify({
          _v: 11,
          conversationState: '',
          text: '',
          fullConversationHeadersOnly: [],
        }),
      );

      const mixed = await add('mixed', [C, D], [], '');

      await execSqlScript({
        ...ctx,
        database: mixed.globalDbPath,
        sql: `INSERT INTO cursorDiskKV VALUES (${sqlText(`composerData:${D}`)},${sqlText('[]')});`,
      });

      const listedMissing = await listWorkspaceChats(ctx, missing);
      const listedBlank = await listWorkspaceChats(ctx, blank);
      const listedMixed = await listWorkspaceChats(ctx, mixed);

      assert.deepEqual(
        listedMissing.allComposers.map((chat) => chat.composerId),
        [A],
      );

      assert.deepEqual(
        listedBlank.allComposers.map((chat) => chat.composerId),
        [B],
      );

      assert.deepEqual(
        listedMixed.allComposers.map((chat) => chat.composerId).sort(),
        [C, D].sort(),
      );

      const updates: Array<{ detail: string; failed?: boolean }> = [];

      const checked = await runStatistics(
        {
          kind: 'chat-statistics',
          ...ctx,
          workspace: blank,
          chats: listedBlank.allComposers,
        },
        new AbortController().signal,
        (row) => updates.push(row),
      );

      assert.equal(checked.failed, 0);
      assert.equal(updates[0]?.failed, undefined);
      assert.match(updates[0]?.detail || '', /user message/);

      const scan = await findEmptyWorkspaces(ctx, {
        kind: 'find-empty-workspaces',
        ...ctx,
        userDataRoot: root,
        workspaces: [missing, blank, mixed],
        emptyWindow: true,
      });

      assert.deepEqual(scan.selected.map((entry) => entry.storageId).sort(), [
        'blank',
        'missing',
      ]);

      assert.equal(scan.unchecked, 1);
      assert.equal(scan.candidates, 2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'invalid, oversized, and plan references are unknown rather than empty',
  { skip },
  async () => {
    const { root, ctx, add } = await profile();

    try {
      const invalid = await add('invalid', [A], [], '[]');

      const unsupported = await add(
        'unsupported',
        [B],
        [],
        JSON.stringify({ _v: 99, conversationState: '~' }),
      );

      const plan = await add(
        'plan',
        [C],
        [],
        JSON.stringify({
          planUri: 'file:///tmp/demo.plan.md',
          fullConversationHeadersOnly: [],
        }),
      );

      const oversized = await add(
        'oversized',
        [D],
        [],
        'x'.repeat(MAX_SQLITE_VALUE_BYTES + 1),
      );

      assert.equal(
        (await assessWorkspaceHistory(ctx, invalid)).state,
        'unknown',
      );

      assert.equal(
        (await assessWorkspaceHistory(ctx, unsupported)).state,
        'unknown',
      );

      assert.equal((await assessWorkspaceHistory(ctx, plan)).state, 'unknown');

      assert.equal(
        (await assessWorkspaceHistory(ctx, oversized)).state,
        'unknown',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'unreadable, busy, corrupt, and missing databases are unavailable',
  { skip },
  async () => {
    const { root, ctx, add } = await profile();

    try {
      const blocked = await add('blocked', []);
      const corrupt = await add('corrupt', []);
      const missing = await add('missing', []);
      const busy = await add('busy', [A]);

      await denyAccess(path.dirname(blocked.workspaceDbPath));
      await writeFile(corrupt.workspaceDbPath, 'not a database');
      await rm(missing.workspaceDbPath, { force: true });

      const writer = await SqliteSession.open({
        ...ctx,
        database: busy.workspaceDbPath,
      });

      try {
        await writer.exec('PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE;');

        assert.equal(
          (await assessWorkspaceHistory({ ...ctx, busyTimeoutMs: 0 }, busy))
            .state,
          'unavailable',
        );
      } finally {
        await writer.close();
      }

      assert.equal(
        (await assessWorkspaceHistory(ctx, blocked)).state,
        'unavailable',
      );

      assert.equal(
        (await assessWorkspaceHistory(ctx, corrupt)).state,
        'unavailable',
      );

      assert.equal(
        (await assessWorkspaceHistory(ctx, missing)).state,
        'unavailable',
      );

      await allowAccess(path.dirname(blocked.workspaceDbPath));
    } finally {
      await allowAccess(path.join(root, 'User', 'workspaceStorage', 'blocked'));

      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'a missing project directory does not hide existing history',
  { skip },
  async () => {
    const { root, ctx, add } = await profile();

    try {
      const entry = await add(
        'kept',
        [A],
        [[`bubbleId:${A}:m`, '{"text":"hi"}']],
      );

      entry.identity = {
        kind: 'folder',
        uri: { scheme: 'file', authority: '', path: '/missing/project' },
      };

      assert.equal(await lstat(entry.workspaceDbPath).then(() => true), true);
      assert.equal((await assessWorkspaceHistory(ctx, entry)).state, 'present');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'current, shared, unresolved, and foreign-image workspaces are not auto-selected',
  { skip },
  async () => {
    const { root, ctx, add } = await profile();
    const image = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

    try {
      const current = await add('current', []);
      const left = await add('left', [A]);
      const right = await add('right', [A]);
      const unresolved = await add('unresolved', [B]);
      const images = await add('images', [C]);

      const other = await add(
        'other',
        [D],
        [[`bubbleId:${D}:m`, JSON.stringify({ images: [{ uuid: image }] })]],
      );

      await execSqlScript({
        ...ctx,
        database: unresolved.globalDbPath,
        sql: `UPDATE ItemTable SET value=${sqlText(
          JSON.stringify({
            allComposers: [
              { composerId: A, workspaceIdentifier: { id: 'left' } },
              { composerId: A, workspaceIdentifier: { id: 'right' } },
              { composerId: B, workspaceIdentifier: { id: 'not-in-profile' } },
              { composerId: C, workspaceIdentifier: { id: 'images' } },
              { composerId: D, workspaceIdentifier: { id: 'other' } },
            ],
          }),
        )} WHERE key='composer.composerHeaders';`,
      });

      await mkdir(path.join(path.dirname(images.workspaceDbPath), 'images'));

      await writeFile(
        path.join(
          path.dirname(images.workspaceDbPath),
          'images',
          `${image}.png`,
        ),
        'png',
      );

      const scan = await findEmptyWorkspaces(ctx, {
        kind: 'find-empty-workspaces',
        ...ctx,
        userDataRoot: root,
        workspaces: [current, left, right, unresolved, images, other],
        database: current.workspaceDbPath,
        identity: current.identity,
        emptyWindow: false,
      });

      assert.deepEqual(
        scan.selected.map((entry) => entry.storageId),
        [],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'same display path in two storages stays two empty selections',
  { skip },
  async () => {
    const { root, ctx, add } = await profile();

    try {
      const local = await add('local', []);
      const remote = await add('remote', []);

      local.identity = remote.identity;

      const scan = await findEmptyWorkspaces(ctx, {
        kind: 'find-empty-workspaces',
        ...ctx,
        userDataRoot: root,
        workspaces: [local, remote],
        emptyWindow: true,
      });

      assert.deepEqual(scan.selected.map((entry) => entry.storageId).sort(), [
        'local',
        'remote',
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'three exclusive workspaces delete with one ownership pass',
  { skip },
  async () => {
    const { root, ctx, add } = await profile();

    try {
      const one = await add('one', [A], [[`bubbleId:${A}:m`, '{}']]);
      const two = await add('two', [B], [[`bubbleId:${B}:m`, '{}']]);
      const three = await add('three', [C], [[`bubbleId:${C}:m`, '{}']]);
      const spare = await add('spare', [D], [[`bubbleId:${D}:m`, '{}']]);

      const prepared = await prepareManagedDelete(ctx, {
        kind: 'prepare-managed-delete',
        ...ctx,
        userDataRoot: root,
        requests: [one, two, three].map((workspace) => ({
          kind: 'workspace-data' as const,
          workspace,
        })),
        workspaces: [one, two, three, spare],
        emptyWindow: true,
      });

      assert.equal(prepared.ok, true);
      if (!prepared.ok) return;

      const counted = await countOwnershipReads(() =>
        executeManagedDelete(ctx, {
          kind: 'delete-managed-data',
          ...ctx,
          plan: prepared.plan,
          workspaces: [one, two, three, spare],
          emptyWindow: true,
        }),
      );

      assert.equal(
        counted.result.outcomes.filter(
          (outcome) => outcome.storage === 'deleted',
        ).length,
        3,
      );

      assert.equal(counted.reads, 1);
      await lstat(spare.workspaceDbPath);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'empty shells with ids delete in one ownership pass',
  { skip },
  async () => {
    const { root, ctx, add } = await profile();

    try {
      const one = await add('one', [A]);
      const two = await add('two', [B]);
      const three = await add('three', [C]);

      const prepared = await prepareManagedDelete(ctx, {
        kind: 'prepare-managed-delete',
        ...ctx,
        userDataRoot: root,
        requests: [one, two, three].map((workspace) => ({
          kind: 'workspace-data' as const,
          workspace,
          requireEmpty: true as const,
        })),
        workspaces: [one, two, three],
        emptyWindow: true,
      });

      assert.equal(prepared.ok, true);
      if (!prepared.ok) return;

      const counted = await countOwnershipReads(() =>
        executeManagedDelete(ctx, {
          kind: 'delete-managed-data',
          ...ctx,
          plan: prepared.plan,
          workspaces: [one, two, three],
          emptyWindow: true,
        }),
      );

      assert.equal(counted.reads, 1);

      assert.equal(
        counted.result.outcomes.every(
          (outcome) => outcome.storage === 'deleted',
        ),
        true,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'cancellation between targets keeps the finished target and stops the next',
  { skip },
  async () => {
    const { root, ctx, add } = await profile();
    const abort = new AbortController();

    try {
      const one = await add('one', [A], [[`bubbleId:${A}:m`, '{}']]);
      const two = await add('two', [B], [[`bubbleId:${B}:m`, '{}']]);

      const prepared = await prepareManagedDelete(ctx, {
        kind: 'prepare-managed-delete',
        ...ctx,
        userDataRoot: root,
        requests: [one, two].map((workspace) => ({
          kind: 'workspace-data' as const,
          workspace,
        })),
        workspaces: [one, two],
        emptyWindow: true,
      });

      assert.equal(prepared.ok, true);
      if (!prepared.ok) return;

      const result = await observeTransfer(
        {
          event: (event) => {
            if (
              event.action === 'Remove workspace data completed' &&
              event.path === path.dirname(one.workspaceDbPath)
            )
              abort.abort();
          },
        },
        () =>
          executeManagedDelete(
            { ...ctx, signal: abort.signal },
            {
              kind: 'delete-managed-data',
              ...ctx,
              plan: prepared.plan,
              workspaces: [one, two],
              emptyWindow: true,
            },
          ),
      );

      assert.equal(result.outcomes[0]?.storage, 'deleted');
      assert.equal(result.outcomes[1]?.storage, 'not-started');
      await lstat(two.workspaceDbPath);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'a filesystem check after removal keeps the committed chat ids',
  { skip },
  async () => {
    const { root, ctx, add } = await profile();
    let workspaceDir = '';

    try {
      const one = await add('one', [A], [[`bubbleId:${A}:m`, '{}']]);

      workspaceDir = path.dirname(one.workspaceDbPath);
      const parent = path.join(root, 'User', 'workspaceStorage');

      const prepared = await prepareManagedDelete(ctx, {
        kind: 'prepare-managed-delete',
        ...ctx,
        userDataRoot: root,
        requests: [{ kind: 'workspace-data', workspace: one }],
        workspaces: [one],
        emptyWindow: true,
      });

      assert.equal(prepared.ok, true);
      if (!prepared.ok) return;

      const result = await withDirectoryRemoval(
        async (directory) => {
          await rm(directory, { recursive: true, force: true });

          // A missing Windows path still stats as ENOENT. Put a denied
          // directory back so the confirmation cannot treat it as gone.
          if (process.platform === 'win32') {
            await mkdir(directory);
            await denyAccess(directory);

            return;
          }

          await denyAccess(parent);
        },
        () =>
          executeManagedDelete(ctx, {
            kind: 'delete-managed-data',
            ...ctx,
            plan: prepared.plan,
            workspaces: [one],
            emptyWindow: true,
          }),
      );

      assert.deepEqual(result.outcomes[0]?.chatIdsDeleted, [A]);
      assert.notEqual(result.outcomes[0]?.storage, 'deleted');
    } finally {
      if (process.platform === 'win32' && workspaceDir)
        await allowAccess(workspaceDir).catch(() => undefined);
      await allowAccess(path.join(root, 'User', 'workspaceStorage'));
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('empty-only progress uses the batch total', { skip }, async () => {
  const { root, ctx, add } = await profile();
  const phases: Array<{ processed?: number; total?: number }> = [];

  try {
    const one = await add('one', []);
    const two = await add('two', []);

    const prepared = await prepareManagedDelete(ctx, {
      kind: 'prepare-managed-delete',
      ...ctx,
      userDataRoot: root,
      requests: [one, two].map((workspace) => ({
        kind: 'workspace-data' as const,
        workspace,
      })),
      workspaces: [one, two],
      emptyWindow: true,
    });

    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;

    await executeManagedDelete(
      {
        ...ctx,
        onPhase: (_phase, metrics) => {
          if (metrics) phases.push(metrics);
        },
      },
      {
        kind: 'delete-managed-data',
        ...ctx,
        plan: prepared.plan,
        workspaces: [one, two],
        emptyWindow: true,
      },
    );

    assert.ok(
      phases.some((metrics) => metrics.processed === 2 && metrics.total === 2),
    );

    assert.equal(
      phases.some((metrics) => metrics.total === 1),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  'a per-row read failure is excluded and counted, and a cancelled scan stops',
  { skip },
  async () => {
    const { root, ctx, add } = await profile();

    try {
      const empty = await add('empty', []);
      const broken = await add('broken', []);

      await writeFile(broken.workspaceDbPath, 'not a database');

      const scan = await findEmptyWorkspaces(ctx, {
        kind: 'find-empty-workspaces',
        ...ctx,
        userDataRoot: root,
        workspaces: [empty, broken],
        emptyWindow: true,
      });

      assert.deepEqual(
        scan.selected.map((entry) => entry.storageId),
        ['empty'],
      );

      assert.equal(scan.unchecked, 1);

      const abort = new AbortController();

      await assert.rejects(
        findEmptyWorkspaces(
          {
            ...ctx,
            signal: abort.signal,
            onPhase: () => abort.abort(),
          },
          {
            kind: 'find-empty-workspaces',
            ...ctx,
            userDataRoot: root,
            workspaces: [empty, broken],
            emptyWindow: true,
          },
        ),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'requireEmpty fails at preparation when history is already present',
  { skip },
  async () => {
    const { root, ctx, add } = await profile();

    try {
      const filled = await add(
        'filled',
        [A],
        [[`bubbleId:${A}:m`, '{"text":"hi"}']],
      );

      const prepared = await prepareManagedDelete(ctx, {
        kind: 'prepare-managed-delete',
        ...ctx,
        userDataRoot: root,
        requests: [
          { kind: 'workspace-data', workspace: filled, requireEmpty: true },
        ],
        workspaces: [filled],
        emptyWindow: true,
      });

      assert.equal(prepared.ok, false);
      await lstat(filled.workspaceDbPath);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
