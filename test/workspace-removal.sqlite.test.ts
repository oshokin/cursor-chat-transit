import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sqlText } from '../src/core';
import {
  executeManagedDelete,
  findEmptyWorkspaces,
  prepareManagedDelete,
} from '../src/managed-delete-run';
import { attachmentDirectory } from '../src/attachments';
import { assessWorkspaceHistory } from '../src/workspace-history';
import { foreignImageRefusal } from '../src/workspace-resources';
import { countOwnershipReads } from '../src/deletion-ownership';
import { withDirectoryRemoval } from '../src/workspace-removal';
import { observeTransfer } from '../src/transfer-events';
import { listWorkspaceEntries } from '../src/paths';
import {
  ensureInitFile,
  execSql,
  execSqlScript,
  findSqliteExecutable,
} from '../src/sqlite';
import type { TransferContext, WorkspaceEntry } from '../src/types';

const executable = findSqliteExecutable(process.env.SQLITE3_PATH);
const skip = executable ? false : 'sqlite3 required';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

async function profile(): Promise<{
  root: string;
  ctx: TransferContext;
  one: WorkspaceEntry;
  empty: WorkspaceEntry;
  shared: WorkspaceEntry;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cct-ws-remove-'));

  const ctx: TransferContext = {
    executable: executable!,
    initFile: await ensureInitFile(root),
  };

  const globalDir = path.join(root, 'User', 'globalStorage');

  await mkdir(globalDir, { recursive: true });
  const globalDbPath = path.join(globalDir, 'state.vscdb');

  /** Build one workspace directory and its entry. */
  async function make(
    storageId: string,
    ids: string[],
  ): Promise<WorkspaceEntry> {
    const directory = path.join(root, 'User', 'workspaceStorage', storageId);

    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'extension-state.txt'), storageId);
    const workspaceDbPath = path.join(directory, 'state.vscdb');

    await execSqlScript({
      ...ctx,
      database: workspaceDbPath,
      sql: `PRAGMA journal_mode=WAL; CREATE TABLE ItemTable(key TEXT PRIMARY KEY,value BLOB); INSERT INTO ItemTable VALUES ('composer.composerData',${sqlText(
        JSON.stringify({
          allComposers: ids.map((composerId) => ({ composerId })),
          selectedComposerIds: ids,
          lastFocusedComposerIds: ids,
        }),
      )}),('unrelated','KEEP');`,
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
  }

  const one = await make('one', [A]);
  const empty = await make('empty', []);
  const shared = await make('shared', [B]);

  await mkdir(path.join(root, 'projects', 'one'), { recursive: true });
  await writeFile(path.join(root, 'projects', 'one', 'sentinel'), 'project');

  await execSqlScript({
    ...ctx,
    database: globalDbPath,
    sql: `PRAGMA journal_mode=WAL; CREATE TABLE ItemTable(key TEXT PRIMARY KEY,value BLOB); CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY,value BLOB); INSERT INTO ItemTable VALUES('composer.composerHeaders',${sqlText(
      JSON.stringify({
        allComposers: [
          { composerId: A, workspaceIdentifier: { id: 'one' } },
          { composerId: B, workspaceIdentifier: { id: 'shared' } },
        ],
      }),
    )}); INSERT INTO cursorDiskKV VALUES ('composerData:${A}','{}'),('bubbleId:${A}:message','{}'),('composerRootWriterDiagnostic:${A}','DROP'),('composerData:${B}','{}'),('composerRootWriterDiagnostic:${B}','KEEP'),('agentKv:${B}:blob','KEEP');`,
  });

  return { root, ctx, one, empty, shared };
}

test(
  'exclusive workspace data removes the directory and keeps project files and shared blobs',
  { skip },
  async () => {
    const { root, ctx, one, empty, shared } = await profile();

    try {
      const prepared = await prepareManagedDelete(ctx, {
        kind: 'prepare-managed-delete',
        executable: ctx.executable,
        initFile: ctx.initFile,
        userDataRoot: root,
        requests: [{ kind: 'workspace-data', workspace: one }],
        workspaces: [one, empty, shared],
        emptyWindow: true,
      });

      assert.equal(prepared.ok, true);
      if (!prepared.ok) return;
      assert.deepEqual(prepared.plan.targets[0]?.ids, [A]);

      const result = await executeManagedDelete(ctx, {
        kind: 'delete-managed-data',
        executable: ctx.executable,
        initFile: ctx.initFile,
        plan: prepared.plan,
        workspaces: [one, empty, shared],
        emptyWindow: true,
      });

      assert.equal(result.outcomes[0]?.storage, 'deleted');
      assert.deepEqual(result.outcomes[0]?.chatIdsDeleted, [A]);
      await assert.rejects(lstat(path.dirname(one.workspaceDbPath)));

      assert.equal(
        await readFile(path.join(root, 'projects', 'one', 'sentinel'), 'utf8'),
        'project',
      );

      assert.equal(
        (
          await execSql({
            ...ctx,
            database: one.globalDbPath,
            sql: `SELECT value FROM cursorDiskKV WHERE key='agentKv:${B}:blob';`,
          })
        ).trim(),
        'KEEP',
      );

      assert.equal(
        (
          await execSql({
            ...ctx,
            database: one.globalDbPath,
            sql: `SELECT count(*) FROM cursorDiskKV WHERE key='composerRootWriterDiagnostic:${A}';`,
          })
        ).trim(),
        '0',
      );

      assert.equal(
        (
          await execSql({
            ...ctx,
            database: one.globalDbPath,
            sql: `SELECT value FROM cursorDiskKV WHERE key='composerRootWriterDiagnostic:${B}';`,
          })
        ).trim(),
        'KEEP',
      );

      assert.equal(
        await readFile(
          path.join(path.dirname(empty.workspaceDbPath), 'extension-state.txt'),
          'utf8',
        ),
        'empty',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'an empty supported workspace directory is removed without deleting unrelated global rows',
  { skip },
  async () => {
    const { root, ctx, one, empty, shared } = await profile();

    try {
      const prepared = await prepareManagedDelete(ctx, {
        kind: 'prepare-managed-delete',
        executable: ctx.executable,
        initFile: ctx.initFile,
        userDataRoot: root,
        requests: [{ kind: 'workspace-data', workspace: empty }],
        workspaces: [one, empty, shared],
        emptyWindow: true,
      });

      assert.equal(prepared.ok, true);
      if (!prepared.ok) return;
      assert.deepEqual(prepared.plan.targets[0]?.ids, []);

      const result = await executeManagedDelete(ctx, {
        kind: 'delete-managed-data',
        executable: ctx.executable,
        initFile: ctx.initFile,
        plan: prepared.plan,
        workspaces: [one, empty, shared],
        emptyWindow: true,
      });

      assert.equal(result.outcomes[0]?.storage, 'deleted');
      assert.deepEqual(result.outcomes[0]?.chatIdsDeleted, []);
      await assert.rejects(lstat(path.dirname(empty.workspaceDbPath)));

      assert.equal(
        (
          await execSql({
            ...ctx,
            database: one.globalDbPath,
            sql: `SELECT count(*) FROM cursorDiskKV WHERE key='composerData:${A}';`,
          })
        ).trim(),
        '1',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'shared history blocks workspace deletion before any directory is removed',
  { skip },
  async () => {
    const { root, ctx, one, empty, shared } = await profile();

    const other = {
      ...shared,
      storageId: 'other',
      workspaceDbPath: path.join(
        root,
        'User',
        'workspaceStorage',
        'other',
        'state.vscdb',
      ),
      key: 'other',
    };

    await mkdir(path.dirname(other.workspaceDbPath), { recursive: true });

    await writeFile(
      path.join(path.dirname(other.workspaceDbPath), 'extension-state.txt'),
      'other',
    );

    await execSqlScript({
      ...ctx,
      database: other.workspaceDbPath,
      sql: `PRAGMA journal_mode=WAL; CREATE TABLE ItemTable(key TEXT PRIMARY KEY,value BLOB); INSERT INTO ItemTable VALUES ('composer.composerData',${sqlText(
        JSON.stringify({
          allComposers: [{ composerId: B }],
          selectedComposerIds: [B],
          lastFocusedComposerIds: [B],
        }),
      )});`,
    });

    try {
      const prepared = await prepareManagedDelete(ctx, {
        kind: 'prepare-managed-delete',
        executable: ctx.executable,
        initFile: ctx.initFile,
        userDataRoot: root,
        requests: [{ kind: 'workspace-data', workspace: shared }],
        workspaces: [one, empty, shared, other],
        emptyWindow: true,
      });

      assert.equal(prepared.ok, false);
      if (prepared.ok) return;
      assert.match(prepared.detail, /another workspace/);

      assert.equal(
        await readFile(
          path.join(
            path.dirname(shared.workspaceDbPath),
            'extension-state.txt',
          ),
          'utf8',
        ),
        'shared',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('chat-only deletion keeps the workspace directory', { skip }, async () => {
  const { root, ctx, one, empty, shared } = await profile();

  try {
    const prepared = await prepareManagedDelete(ctx, {
      kind: 'prepare-managed-delete',
      executable: ctx.executable,
      initFile: ctx.initFile,
      userDataRoot: root,
      requests: [{ kind: 'chats', workspace: one, ids: [A] }],
      workspaces: [one, empty, shared],
      emptyWindow: true,
    });

    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;

    const result = await executeManagedDelete(ctx, {
      kind: 'delete-managed-data',
      executable: ctx.executable,
      initFile: ctx.initFile,
      plan: prepared.plan,
      workspaces: [one, empty, shared],
      emptyWindow: true,
    });

    assert.equal(
      result.outcomes[0]?.storage,
      'not-requested',
      JSON.stringify(result),
    );

    assert.deepEqual(result.outcomes[0]?.chatIdsDeleted, [A]);

    assert.equal(
      await readFile(
        path.join(path.dirname(one.workspaceDbPath), 'extension-state.txt'),
        'utf8',
      ),
      'one',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const Z = '33333333-3333-4333-8333-333333333333';

test(
  'a new chat after preparation leaves the workspace and that chat in place',
  { skip },
  async () => {
    const { root, ctx, one, empty, shared } = await profile();

    try {
      const prepared = await prepareManagedDelete(ctx, {
        kind: 'prepare-managed-delete',
        executable: ctx.executable,
        initFile: ctx.initFile,
        userDataRoot: root,
        requests: [{ kind: 'workspace-data', workspace: one }],
        workspaces: [one, empty, shared],
        emptyWindow: true,
      });

      assert.equal(prepared.ok, true);
      if (!prepared.ok) return;

      const headers = JSON.parse(
        (
          await execSql({
            ...ctx,
            database: one.globalDbPath,
            sql: `SELECT value FROM ItemTable WHERE key='composer.composerHeaders';`,
          })
        ).trim(),
      ) as { allComposers: unknown[] };

      headers.allComposers.push({
        composerId: Z,
        workspaceIdentifier: { id: 'one' },
      });

      await execSqlScript({
        ...ctx,
        database: one.globalDbPath,
        sql: `UPDATE ItemTable SET value=${sqlText(JSON.stringify(headers))} WHERE key='composer.composerHeaders';`,
      });

      const result = await executeManagedDelete(ctx, {
        kind: 'delete-managed-data',
        executable: ctx.executable,
        initFile: ctx.initFile,
        plan: prepared.plan,
        workspaces: [one, empty, shared],
        emptyWindow: true,
      });

      assert.equal(result.outcomes[0]?.storage, 'not-started');
      assert.deepEqual(result.outcomes[0]?.chatIdsDeleted, []);
      await lstat(one.workspaceDbPath);

      assert.equal(
        (
          await execSql({
            ...ctx,
            database: one.globalDbPath,
            sql: `SELECT count(*) FROM cursorDiskKV WHERE key='composerData:${A}';`,
          })
        ).trim(),
        '1',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'an unrelated workspace value does not block a confirmed delete',
  { skip },
  async () => {
    const { root, ctx, one, empty, shared } = await profile();

    try {
      const prepared = await prepareManagedDelete(ctx, {
        kind: 'prepare-managed-delete',
        executable: ctx.executable,
        initFile: ctx.initFile,
        userDataRoot: root,
        requests: [{ kind: 'workspace-data', workspace: one }],
        workspaces: [one, empty, shared],
        emptyWindow: true,
      });

      assert.equal(prepared.ok, true);
      if (!prepared.ok) return;

      await execSqlScript({
        ...ctx,
        database: one.workspaceDbPath,
        sql: `UPDATE ItemTable SET value='KEEP2' WHERE key='unrelated';`,
      });

      const result = await executeManagedDelete(ctx, {
        kind: 'delete-managed-data',
        executable: ctx.executable,
        initFile: ctx.initFile,
        plan: prepared.plan,
        workspaces: [one, empty, shared],
        emptyWindow: true,
      });

      assert.equal(
        result.outcomes[0]?.storage,
        'deleted',
        JSON.stringify(result),
      );

      await assert.rejects(lstat(one.workspaceDbPath));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'an unreadable workspace database is refused before any deletion',
  { skip },
  async () => {
    const { root, ctx, one, empty, shared } = await profile();

    try {
      await writeFile(one.workspaceDbPath, '');

      const prepared = await prepareManagedDelete(ctx, {
        kind: 'prepare-managed-delete',
        executable: ctx.executable,
        initFile: ctx.initFile,
        userDataRoot: root,
        requests: [{ kind: 'workspace-data', workspace: one }],
        workspaces: [one, empty, shared],
        emptyWindow: true,
      });

      assert.equal(prepared.ok, false);
      if (prepared.ok) return;
      assert.match(prepared.detail, /No data was deleted/);
      await lstat(one.workspaceDbPath);
      await lstat(empty.workspaceDbPath);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'a trigger added after preparation keeps the directory and the chat',
  { skip },
  async () => {
    const { root, ctx, one, empty, shared } = await profile();

    try {
      const prepared = await prepareManagedDelete(ctx, {
        kind: 'prepare-managed-delete',
        executable: ctx.executable,
        initFile: ctx.initFile,
        userDataRoot: root,
        requests: [{ kind: 'workspace-data', workspace: one }],
        workspaces: [one, empty, shared],
        emptyWindow: true,
      });

      assert.equal(prepared.ok, true);
      if (!prepared.ok) return;

      await execSqlScript({
        ...ctx,
        database: one.globalDbPath,
        sql: `CREATE TRIGGER block_delete BEFORE DELETE ON cursorDiskKV BEGIN SELECT RAISE(ABORT, 'blocked'); END;`,
      });

      const result = await executeManagedDelete(ctx, {
        kind: 'delete-managed-data',
        executable: ctx.executable,
        initFile: ctx.initFile,
        plan: prepared.plan,
        workspaces: [one, empty, shared],
        emptyWindow: true,
      });

      assert.equal(result.outcomes[0]?.storage, 'not-started');
      await lstat(one.workspaceDbPath);

      assert.equal(
        (
          await execSql({
            ...ctx,
            database: one.globalDbPath,
            sql: `SELECT count(*) FROM cursorDiskKV WHERE key='composerData:${A}';`,
          })
        ).trim(),
        '1',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'a workspace that disappears before deletion is not counted as deleted',
  { skip },
  async () => {
    const { root, ctx, one, empty, shared } = await profile();

    try {
      const prepared = await prepareManagedDelete(ctx, {
        kind: 'prepare-managed-delete',
        executable: ctx.executable,
        initFile: ctx.initFile,
        userDataRoot: root,
        requests: [{ kind: 'workspace-data', workspace: one }],
        workspaces: [one, empty, shared],
        emptyWindow: true,
      });

      assert.equal(prepared.ok, true);
      if (!prepared.ok) return;

      await rm(path.dirname(one.workspaceDbPath), {
        recursive: true,
        force: true,
      });

      const result = await executeManagedDelete(ctx, {
        kind: 'delete-managed-data',
        executable: ctx.executable,
        initFile: ctx.initFile,
        plan: prepared.plan,
        workspaces: [one, empty, shared],
        emptyWindow: true,
      });

      assert.equal(result.outcomes[0]?.storage, 'unknown');

      assert.equal(
        result.outcomes[0]?.errorMessage,
        'Workspace data was already gone.',
      );

      assert.deepEqual(result.outcomes[0]?.chatIdsDeleted, []);
      await lstat(empty.workspaceDbPath);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'a recreated workspace is visible again and the old plan does not delete it',
  { skip },
  async () => {
    const { root, ctx, one, empty, shared } = await profile();

    try {
      const prepared = await prepareManagedDelete(ctx, {
        kind: 'prepare-managed-delete',
        executable: ctx.executable,
        initFile: ctx.initFile,
        userDataRoot: root,
        requests: [{ kind: 'workspace-data', workspace: one }],
        workspaces: [one, empty, shared],
        emptyWindow: true,
      });

      assert.equal(prepared.ok, true);
      if (!prepared.ok) return;

      const removed = await executeManagedDelete(ctx, {
        kind: 'delete-managed-data',
        executable: ctx.executable,
        initFile: ctx.initFile,
        plan: prepared.plan,
        workspaces: [one, empty, shared],
        emptyWindow: true,
      });

      assert.equal(removed.outcomes[0]?.storage, 'deleted');
      await mkdir(path.dirname(one.workspaceDbPath), { recursive: true });

      await execSqlScript({
        ...ctx,
        database: one.workspaceDbPath,
        sql: `CREATE TABLE ItemTable(key TEXT PRIMARY KEY,value BLOB); INSERT INTO ItemTable VALUES ('composer.composerData','{}'),('unrelated','NEW');`,
      });

      assert.ok(
        listWorkspaceEntries(root).some(
          (entry) => entry.storageId === one.storageId,
        ),
      );

      const again = await executeManagedDelete(ctx, {
        kind: 'delete-managed-data',
        executable: ctx.executable,
        initFile: ctx.initFile,
        plan: prepared.plan,
        workspaces: [one, empty, shared],
        emptyWindow: true,
      });

      assert.notEqual(again.outcomes[0]?.storage, 'deleted');

      assert.equal(
        (
          await execSql({
            ...ctx,
            database: one.workspaceDbPath,
            sql: `SELECT value FROM ItemTable WHERE key='unrelated';`,
          })
        ).trim(),
        'NEW',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'an image inside the workspace goes away and another chat body stays',
  { skip },
  async () => {
    const { root, ctx, one, empty, shared } = await profile();

    const image = path.join(
      path.dirname(one.workspaceDbPath),
      'images',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png',
    );

    const before = (
      await execSql({
        ...ctx,
        database: one.globalDbPath,
        sql: `SELECT value FROM cursorDiskKV WHERE key='composerData:${B}';`,
      })
    ).trim();

    try {
      await mkdir(path.dirname(image), { recursive: true });
      await writeFile(image, 'image-bytes');

      const prepared = await prepareManagedDelete(ctx, {
        kind: 'prepare-managed-delete',
        executable: ctx.executable,
        initFile: ctx.initFile,
        userDataRoot: root,
        requests: [{ kind: 'workspace-data', workspace: one }],
        workspaces: [one, empty, shared],
        emptyWindow: true,
      });

      assert.equal(prepared.ok, true);
      if (!prepared.ok) return;

      const result = await executeManagedDelete(ctx, {
        kind: 'delete-managed-data',
        executable: ctx.executable,
        initFile: ctx.initFile,
        plan: prepared.plan,
        workspaces: [one, empty, shared],
        emptyWindow: true,
      });

      assert.equal(result.outcomes[0]?.storage, 'deleted');
      await assert.rejects(lstat(image));

      assert.equal(
        (
          await execSql({
            ...ctx,
            database: one.globalDbPath,
            sql: `SELECT value FROM cursorDiskKV WHERE key='composerData:${B}';`,
          })
        ).trim(),
        before,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'the current window keeps its storage when its database is reached through a symlink',
  { skip },
  async () => {
    const { root, ctx, one, empty, shared } = await profile();
    const alias = path.join(root, 'alias-state.vscdb');

    try {
      await symlink(one.workspaceDbPath, alias);

      const prepared = await prepareManagedDelete(ctx, {
        kind: 'prepare-managed-delete',
        executable: ctx.executable,
        initFile: ctx.initFile,
        userDataRoot: root,
        requests: [
          { kind: 'workspace-data', workspace: one },
          { kind: 'workspace-data', workspace: empty },
        ],
        workspaces: [one, empty, shared],
        emptyWindow: false,
        database: alias,
      });

      assert.equal(prepared.ok, true);
      if (!prepared.ok) return;

      const current = prepared.plan.targets.find(
        (target) => target.workspace.workspaceDbPath === one.workspaceDbPath,
      );

      assert.equal(current?.kind, 'chats');
      assert.equal(current?.storageKept, true);

      assert.equal(
        prepared.plan.targets.some(
          (target) =>
            target.workspace.workspaceDbPath === empty.workspaceDbPath &&
            target.kind === 'workspace-data',
        ),
        true,
      );

      await lstat(one.workspaceDbPath);
      await lstat(empty.workspaceDbPath);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'a changed profile path does not receive the confirmed plan',
  { skip },
  async () => {
    const { root, ctx, one, empty, shared } = await profile();

    try {
      const prepared = await prepareManagedDelete(ctx, {
        kind: 'prepare-managed-delete',
        executable: ctx.executable,
        initFile: ctx.initFile,
        userDataRoot: root,
        requests: [{ kind: 'workspace-data', workspace: one }],
        workspaces: [one, empty, shared],
        emptyWindow: true,
      });

      assert.equal(prepared.ok, true);
      if (!prepared.ok) return;
      const elsewhere = path.join(root, 'other-global.vscdb');

      await writeFile(elsewhere, '');

      const result = await executeManagedDelete(ctx, {
        kind: 'delete-managed-data',
        executable: ctx.executable,
        initFile: ctx.initFile,
        plan: prepared.plan,
        workspaces: [{ ...one, globalDbPath: elsewhere }, empty, shared],
        emptyWindow: true,
      });

      assert.equal(result.outcomes[0]?.storage, 'not-started');
      await lstat(one.workspaceDbPath);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'cancellation before the first write leaves the directory and the chat',
  { skip },
  async () => {
    const { root, ctx, one, empty, shared } = await profile();
    const abort = new AbortController();

    abort.abort();

    try {
      const prepared = await prepareManagedDelete(ctx, {
        kind: 'prepare-managed-delete',
        executable: ctx.executable,
        initFile: ctx.initFile,
        userDataRoot: root,
        requests: [{ kind: 'workspace-data', workspace: one }],
        workspaces: [one, empty, shared],
        emptyWindow: true,
      });

      assert.equal(prepared.ok, true);
      if (!prepared.ok) return;

      const result = await executeManagedDelete(
        { ...ctx, signal: abort.signal },
        {
          kind: 'delete-managed-data',
          executable: ctx.executable,
          initFile: ctx.initFile,
          plan: prepared.plan,
          workspaces: [one, empty, shared],
          emptyWindow: true,
        },
      );

      assert.equal(result.cancelled, true);
      assert.equal(result.outcomes[0]?.storage, 'not-started');
      assert.deepEqual(result.outcomes[0]?.chatIdsDeleted, []);
      await lstat(one.workspaceDbPath);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'cancellation after the chat commit does not start directory removal',
  { skip },
  async () => {
    const { root, ctx, one, empty, shared } = await profile();
    const abort = new AbortController();

    try {
      const prepared = await prepareManagedDelete(ctx, {
        kind: 'prepare-managed-delete',
        executable: ctx.executable,
        initFile: ctx.initFile,
        userDataRoot: root,
        requests: [{ kind: 'workspace-data', workspace: one }],
        workspaces: [one, empty, shared],
        emptyWindow: true,
      });

      assert.equal(prepared.ok, true);
      if (!prepared.ok) return;

      const result = await observeTransfer(
        {
          event: (event) => {
            if (event.action === 'Delete chat' && event.status === 'completed')
              abort.abort();
          },
        },
        () =>
          executeManagedDelete(
            { ...ctx, signal: abort.signal },
            {
              kind: 'delete-managed-data',
              executable: ctx.executable,
              initFile: ctx.initFile,
              plan: prepared.plan,
              workspaces: [one, empty, shared],
              emptyWindow: true,
            },
          ),
      );

      assert.equal(result.outcomes[0]?.storage, 'not-started');
      assert.deepEqual(result.outcomes[0]?.chatIdsDeleted, [A]);
      await lstat(one.workspaceDbPath);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'a directory removal that is already running is counted, and the next workspace stays',
  { skip },
  async () => {
    const { root, ctx, one, empty, shared } = await profile();
    const abort = new AbortController();

    try {
      const prepared = await prepareManagedDelete(ctx, {
        kind: 'prepare-managed-delete',
        executable: ctx.executable,
        initFile: ctx.initFile,
        userDataRoot: root,
        requests: [
          { kind: 'workspace-data', workspace: one },
          { kind: 'workspace-data', workspace: empty },
        ],
        workspaces: [one, empty, shared],
        emptyWindow: true,
      });

      assert.equal(prepared.ok, true);
      if (!prepared.ok) return;

      const result = await withDirectoryRemoval(
        async (directory) => {
          abort.abort();
          await rm(directory, { recursive: true, force: true });
        },
        () =>
          executeManagedDelete(
            { ...ctx, signal: abort.signal },
            {
              kind: 'delete-managed-data',
              executable: ctx.executable,
              initFile: ctx.initFile,
              plan: prepared.plan,
              workspaces: [one, empty, shared],
              emptyWindow: true,
            },
          ),
      );

      assert.equal(result.cancelled, true);
      assert.equal(result.outcomes[0]?.storage, 'deleted');
      assert.equal(result.outcomes[1]?.storage, 'not-started');
      await assert.rejects(lstat(path.dirname(one.workspaceDbPath)));
      await lstat(empty.workspaceDbPath);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'a busy directory after chat deletion is partial and the next workspace stays',
  { skip },
  async () => {
    const { root, ctx, one, empty, shared } = await profile();
    let attempts = 0;

    try {
      const prepared = await prepareManagedDelete(ctx, {
        kind: 'prepare-managed-delete',
        executable: ctx.executable,
        initFile: ctx.initFile,
        userDataRoot: root,
        requests: [
          { kind: 'workspace-data', workspace: one },
          { kind: 'workspace-data', workspace: empty },
        ],
        workspaces: [one, empty, shared],
        emptyWindow: true,
      });

      assert.equal(prepared.ok, true);
      if (!prepared.ok) return;

      const result = await withDirectoryRemoval(
        async () => {
          attempts += 1;

          throw Object.assign(new Error('busy'), { code: 'EBUSY' });
        },
        () =>
          executeManagedDelete(ctx, {
            kind: 'delete-managed-data',
            executable: ctx.executable,
            initFile: ctx.initFile,
            plan: prepared.plan,
            workspaces: [one, empty, shared],
            emptyWindow: true,
          }),
      );

      assert.equal(attempts, 3);
      assert.equal(result.outcomes[0]?.storage, 'partial');
      assert.deepEqual(result.outcomes[0]?.chatIdsDeleted, [A]);
      assert.equal(result.outcomes[1]?.storage, 'not-started');
      await lstat(one.workspaceDbPath);
      await lstat(empty.workspaceDbPath);

      assert.equal(
        (
          await execSql({
            ...ctx,
            database: one.globalDbPath,
            sql: `SELECT count(*) FROM cursorDiskKV WHERE key='composerData:${A}';`,
          })
        ).trim(),
        '0',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'a filesystem error after a partial directory delete is not a rollback',
  { skip },
  async () => {
    const { root, ctx, one, empty, shared } = await profile();

    try {
      const prepared = await prepareManagedDelete(ctx, {
        kind: 'prepare-managed-delete',
        executable: ctx.executable,
        initFile: ctx.initFile,
        userDataRoot: root,
        requests: [
          { kind: 'workspace-data', workspace: one },
          { kind: 'workspace-data', workspace: empty },
        ],
        workspaces: [one, empty, shared],
        emptyWindow: true,
      });

      assert.equal(prepared.ok, true);
      if (!prepared.ok) return;

      const result = await withDirectoryRemoval(
        async (directory) => {
          await rm(path.join(directory, 'extension-state.txt'), {
            force: true,
          });

          throw Object.assign(new Error('io'), { code: 'EIO' });
        },
        () =>
          executeManagedDelete(ctx, {
            kind: 'delete-managed-data',
            executable: ctx.executable,
            initFile: ctx.initFile,
            plan: prepared.plan,
            workspaces: [one, empty, shared],
            emptyWindow: true,
          }),
      );

      assert.equal(result.outcomes[0]?.storage, 'partial');
      assert.equal(result.outcomes[0]?.errorCode, 'EIO');
      assert.notEqual(result.outcomes[0]?.storage, 'deleted');
      assert.equal(result.outcomes[1]?.storage, 'not-started');

      await assert.rejects(
        lstat(
          path.join(path.dirname(one.workspaceDbPath), 'extension-state.txt'),
        ),
      );

      await lstat(one.workspaceDbPath);
      await lstat(empty.workspaceDbPath);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'two exclusive workspaces both delete after the first directory is gone',
  { skip },
  async () => {
    const { root, ctx, one, empty, shared } = await profile();

    try {
      const prepared = await prepareManagedDelete(ctx, {
        kind: 'prepare-managed-delete',
        executable: ctx.executable,
        initFile: ctx.initFile,
        userDataRoot: root,
        requests: [
          { kind: 'workspace-data', workspace: one },
          { kind: 'workspace-data', workspace: shared },
        ],
        workspaces: [one, empty, shared],
        emptyWindow: true,
      });

      assert.equal(prepared.ok, true);
      if (!prepared.ok) return;

      const counted = await countOwnershipReads(() =>
        executeManagedDelete(ctx, {
          kind: 'delete-managed-data',
          executable: ctx.executable,
          initFile: ctx.initFile,
          plan: prepared.plan,
          workspaces: [one, empty, shared],
          emptyWindow: true,
        }),
      );

      assert.equal(
        counted.result.outcomes[1]?.storage,
        'deleted',
        JSON.stringify(counted.result),
      );

      assert.equal(counted.reads, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'an unrelated workspace row does not block a confirmed delete',
  { skip },
  async () => {
    const { root, ctx, one, empty, shared } = await profile();

    try {
      const prepared = await prepareManagedDelete(ctx, {
        kind: 'prepare-managed-delete',
        executable: ctx.executable,
        initFile: ctx.initFile,
        userDataRoot: root,
        requests: [
          { kind: 'workspace-data', workspace: one },
          { kind: 'workspace-data', workspace: shared },
        ],
        workspaces: [one, empty, shared],
        emptyWindow: true,
      });

      assert.equal(prepared.ok, true);
      if (!prepared.ok) return;

      await execSqlScript({
        ...ctx,
        database: shared.workspaceDbPath,
        sql: "INSERT INTO ItemTable VALUES ('changed-after-confirmation','yes');",
      });

      const result = await executeManagedDelete(ctx, {
        kind: 'delete-managed-data',
        executable: ctx.executable,
        initFile: ctx.initFile,
        plan: prepared.plan,
        workspaces: [one, empty, shared],
        emptyWindow: true,
      });

      assert.equal(
        result.outcomes.every((outcome) => outcome.storage === 'deleted'),
        true,
        JSON.stringify(result),
      );

      await assert.rejects(lstat(one.workspaceDbPath));
      await assert.rejects(lstat(shared.workspaceDbPath));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'an unrelated global key does not block a confirmed delete',
  { skip },
  async () => {
    const { root, ctx, one, empty, shared } = await profile();

    try {
      const prepared = await prepareManagedDelete(ctx, {
        kind: 'prepare-managed-delete',
        executable: ctx.executable,
        initFile: ctx.initFile,
        userDataRoot: root,
        requests: [{ kind: 'workspace-data', workspace: one }],
        workspaces: [one, empty, shared],
        emptyWindow: true,
      });

      assert.equal(prepared.ok, true);
      if (!prepared.ok) return;

      await execSqlScript({
        ...ctx,
        database: one.globalDbPath,
        sql: `INSERT INTO cursorDiskKV VALUES ('agentKv:blob:noise','unrelated');`,
      });

      const result = await executeManagedDelete(ctx, {
        kind: 'delete-managed-data',
        executable: ctx.executable,
        initFile: ctx.initFile,
        plan: prepared.plan,
        workspaces: [one, empty, shared],
        emptyWindow: true,
      });

      assert.equal(
        result.outcomes[0]?.storage,
        'deleted',
        JSON.stringify(result),
      );

      await assert.rejects(lstat(one.workspaceDbPath));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'a changed global message invalidates the plan before any write',
  { skip },
  async () => {
    const { root, ctx, one, empty, shared } = await profile();

    try {
      const prepared = await prepareManagedDelete(ctx, {
        kind: 'prepare-managed-delete',
        executable: ctx.executable,
        initFile: ctx.initFile,
        userDataRoot: root,
        requests: [{ kind: 'workspace-data', workspace: one }],
        workspaces: [one, empty, shared],
        emptyWindow: true,
      });

      assert.equal(prepared.ok, true);
      if (!prepared.ok) return;

      await execSqlScript({
        ...ctx,
        database: one.globalDbPath,
        sql: `UPDATE cursorDiskKV SET value='{"text":"new user message"}' WHERE key='bubbleId:${A}:message';`,
      });

      const result = await executeManagedDelete(ctx, {
        kind: 'delete-managed-data',
        executable: ctx.executable,
        initFile: ctx.initFile,
        plan: prepared.plan,
        workspaces: [one, empty, shared],
        emptyWindow: true,
      });

      assert.equal(
        result.outcomes.some((outcome) => outcome.storage === 'deleted'),
        false,
        JSON.stringify(result),
      );

      await lstat(one.workspaceDbPath);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'batch progress counts every target, including an empty directory',
  { skip },
  async () => {
    const { root, ctx, one, empty, shared } = await profile();
    const phases: Array<{ processed?: number; total?: number }> = [];

    try {
      const prepared = await prepareManagedDelete(ctx, {
        kind: 'prepare-managed-delete',
        executable: ctx.executable,
        initFile: ctx.initFile,
        userDataRoot: root,
        requests: [
          { kind: 'workspace-data', workspace: one },
          { kind: 'workspace-data', workspace: empty },
        ],
        workspaces: [one, empty, shared],
        emptyWindow: true,
      });

      assert.equal(prepared.ok, true);
      if (!prepared.ok) return;

      const result = await executeManagedDelete(
        {
          ...ctx,
          onPhase: (_phase, metrics) => {
            if (metrics) phases.push(metrics);
          },
        },
        {
          kind: 'delete-managed-data',
          executable: ctx.executable,
          initFile: ctx.initFile,
          plan: prepared.plan,
          workspaces: [one, empty, shared],
          emptyWindow: true,
        },
      );

      assert.equal(
        result.outcomes.filter((outcome) => outcome.storage === 'deleted')
          .length,
        2,
      );

      assert.ok(
        phases.some(
          (metrics) => metrics.processed === 2 && metrics.total === 2,
        ),
        JSON.stringify(phases),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('a missing unselected database blocks the batch', { skip }, async () => {
  const { root, ctx, one, empty, shared } = await profile();

  try {
    const prepared = await prepareManagedDelete(ctx, {
      kind: 'prepare-managed-delete',
      executable: ctx.executable,
      initFile: ctx.initFile,
      userDataRoot: root,
      requests: [
        { kind: 'workspace-data', workspace: one },
        { kind: 'workspace-data', workspace: shared },
      ],
      workspaces: [one, empty, shared],
      emptyWindow: true,
    });

    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;

    await rm(path.dirname(empty.workspaceDbPath), {
      recursive: true,
      force: true,
    });

    const result = await executeManagedDelete(ctx, {
      kind: 'delete-managed-data',
      executable: ctx.executable,
      initFile: ctx.initFile,
      plan: prepared.plan,
      workspaces: [one, empty, shared],
      emptyWindow: true,
    });

    assert.equal(
      result.outcomes.some((outcome) => outcome.storage === 'deleted'),
      false,
    );

    await lstat(one.workspaceDbPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  'an image referenced by another chat refuses workspace removal',
  { skip },
  async () => {
    const { root, ctx, one, empty, shared } = await profile();
    const image = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

    try {
      await mkdir(path.join(path.dirname(one.workspaceDbPath), 'images'));

      await writeFile(
        path.join(path.dirname(one.workspaceDbPath), 'images', `${image}.png`),
        'png',
      );

      await execSqlScript({
        ...ctx,
        database: one.globalDbPath,
        sql: `INSERT INTO cursorDiskKV VALUES ('bubbleId:${B}:image','{"images":[{"uuid":"${image}"}]}');`,
      });

      const prepared = await prepareManagedDelete(ctx, {
        kind: 'prepare-managed-delete',
        executable: ctx.executable,
        initFile: ctx.initFile,
        userDataRoot: root,
        requests: [{ kind: 'workspace-data', workspace: one }],
        workspaces: [one, empty, shared],
        emptyWindow: true,
      });

      assert.equal(prepared.ok, false);

      await lstat(
        path.join(path.dirname(one.workspaceDbPath), 'images', `${image}.png`),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'a draft or task-tool id in another composer does not stop workspace removal',
  { skip },
  async () => {
    const { root, ctx, one, empty, shared } = await profile();
    const image = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const taskTool = 'task-tool_a404505b-10a1-4846-b615-eec50b9c1bc';

    try {
      await mkdir(path.join(path.dirname(one.workspaceDbPath), 'images'));

      await writeFile(
        path.join(path.dirname(one.workspaceDbPath), 'images', `${image}.png`),
        'png',
      );

      await execSqlScript({
        ...ctx,
        database: one.globalDbPath,
        sql: `INSERT INTO cursorDiskKV VALUES
          ('composerData:empty-state-draft','{}'),
          (${sqlText(`composerData:${taskTool}`)},'{}');`,
      });

      const prepared = await prepareManagedDelete(ctx, {
        kind: 'prepare-managed-delete',
        executable: ctx.executable,
        initFile: ctx.initFile,
        userDataRoot: root,
        requests: [{ kind: 'workspace-data', workspace: one }],
        workspaces: [one, empty, shared],
        emptyWindow: true,
      });

      assert.equal(prepared.ok, true);

      await execSqlScript({
        ...ctx,
        database: one.globalDbPath,
        sql: `INSERT INTO cursorDiskKV VALUES ('bubbleId:empty-state-draft:image',${sqlText(
          JSON.stringify({ images: [{ uuid: image }] }),
        )});`,
      });

      const refused = await prepareManagedDelete(ctx, {
        kind: 'prepare-managed-delete',
        executable: ctx.executable,
        initFile: ctx.initFile,
        userDataRoot: root,
        requests: [{ kind: 'workspace-data', workspace: one }],
        workspaces: [one, empty, shared],
        emptyWindow: true,
      });

      assert.equal(refused.ok, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'an unsupported composer id is not treated as proof that images are unused',
  { skip },
  async () => {
    const { root, ctx, one, empty, shared } = await profile();

    try {
      await mkdir(path.join(path.dirname(one.workspaceDbPath), 'images'));

      await writeFile(
        path.join(
          path.dirname(one.workspaceDbPath),
          'images',
          'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png',
        ),
        'png',
      );

      await execSqlScript({
        ...ctx,
        database: one.globalDbPath,
        sql: `INSERT INTO cursorDiskKV VALUES ('composerData:not a uuid','{}');`,
      });

      const prepared = await prepareManagedDelete(ctx, {
        kind: 'prepare-managed-delete',
        executable: ctx.executable,
        initFile: ctx.initFile,
        userDataRoot: root,
        requests: [{ kind: 'workspace-data', workspace: one }],
        workspaces: [one, empty, shared],
        emptyWindow: true,
      });

      assert.equal(prepared.ok, false);
      if (prepared.ok) return;
      assert.match(prepared.detail, /supported format/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('a directory replaced after SQL is not removed', { skip }, async () => {
  const { root, ctx, one, empty, shared } = await profile();
  const directory = path.dirname(one.workspaceDbPath);

  try {
    const prepared = await prepareManagedDelete(ctx, {
      kind: 'prepare-managed-delete',
      executable: ctx.executable,
      initFile: ctx.initFile,
      userDataRoot: root,
      requests: [{ kind: 'workspace-data', workspace: one }],
      workspaces: [one, empty, shared],
      emptyWindow: true,
    });

    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;

    const result = await observeTransfer(
      {
        event: (event) => {
          if (event.action !== 'Delete chat' || event.status !== 'completed')
            return;

          rmSync(directory, { recursive: true, force: true });
          mkdirSync(directory, { recursive: true });
          writeFileSync(path.join(directory, 'replacement'), 'kept');
        },
      },
      () =>
        executeManagedDelete(ctx, {
          kind: 'delete-managed-data',
          executable: ctx.executable,
          initFile: ctx.initFile,
          plan: prepared.plan,
          workspaces: [one, empty, shared],
          emptyWindow: true,
        }),
    );

    assert.notEqual(result.outcomes[0]?.storage, 'deleted');
    assert.deepEqual(result.outcomes[0]?.chatIdsDeleted, [A]);

    assert.equal(
      await readFile(path.join(directory, 'replacement'), 'utf8'),
      'kept',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('requireEmpty ignores an unrelated global write', { skip }, async () => {
  const { root, ctx, one, empty, shared } = await profile();

  try {
    const prepared = await prepareManagedDelete(ctx, {
      kind: 'prepare-managed-delete',
      executable: ctx.executable,
      initFile: ctx.initFile,
      userDataRoot: root,
      requests: [
        { kind: 'workspace-data', workspace: empty, requireEmpty: true },
      ],
      workspaces: [one, empty, shared],
      emptyWindow: true,
    });

    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;

    await execSqlScript({
      ...ctx,
      database: empty.globalDbPath,
      sql: `INSERT INTO cursorDiskKV VALUES ('bubbleId:${B}:later','{"text":"created later"}');`,
    });

    const deleted = await executeManagedDelete(ctx, {
      kind: 'delete-managed-data',
      executable: ctx.executable,
      initFile: ctx.initFile,
      plan: prepared.plan,
      workspaces: [one, empty, shared],
      emptyWindow: true,
    });

    assert.equal(
      deleted.outcomes[0]?.storage,
      'deleted',
      JSON.stringify(deleted),
    );

    await assert.rejects(lstat(empty.workspaceDbPath));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  'requireEmpty refuses a workspace that gained its own composer',
  { skip },
  async () => {
    const { root, ctx, one, empty, shared } = await profile();
    const gained = '55555555-5555-4555-8555-555555555555';

    try {
      const prepared = await prepareManagedDelete(ctx, {
        kind: 'prepare-managed-delete',
        executable: ctx.executable,
        initFile: ctx.initFile,
        userDataRoot: root,
        requests: [
          { kind: 'workspace-data', workspace: empty, requireEmpty: true },
        ],
        workspaces: [one, empty, shared],
        emptyWindow: true,
      });

      assert.equal(prepared.ok, true);
      if (!prepared.ok) return;

      await execSqlScript({
        ...ctx,
        database: empty.workspaceDbPath,
        sql: `UPDATE ItemTable SET value=${sqlText(
          JSON.stringify({
            allComposers: [{ composerId: gained }],
            selectedComposerIds: [gained],
            lastFocusedComposerIds: [gained],
          }),
        )} WHERE key='composer.composerData';`,
      });

      const result = await executeManagedDelete(ctx, {
        kind: 'delete-managed-data',
        executable: ctx.executable,
        initFile: ctx.initFile,
        plan: prepared.plan,
        workspaces: [one, empty, shared],
        emptyWindow: true,
      });

      assert.match(result.error || '', /no longer empty/);
      assert.equal(result.outcomes[0]?.storage, 'not-started');
      await lstat(empty.workspaceDbPath);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'empty history is classified without treating a bubble as empty',
  { skip },
  async () => {
    const { root, ctx, one, empty, shared } = await profile();

    try {
      assert.equal((await assessWorkspaceHistory(ctx, empty)).state, 'empty');
      assert.equal((await assessWorkspaceHistory(ctx, shared)).state, 'empty');
      assert.equal((await assessWorkspaceHistory(ctx, one)).state, 'present');

      const scan = await findEmptyWorkspaces(ctx, {
        kind: 'find-empty-workspaces',
        executable: ctx.executable,
        initFile: ctx.initFile,
        userDataRoot: root,
        workspaces: [one, empty, shared],
        emptyWindow: true,
      });

      assert.deepEqual(scan.selected.map((entry) => entry.storageId).sort(), [
        'empty',
        'shared',
      ]);

      const current = await findEmptyWorkspaces(ctx, {
        kind: 'find-empty-workspaces',
        executable: ctx.executable,
        initFile: ctx.initFile,
        userDataRoot: root,
        workspaces: [one, empty, shared],
        database: empty.workspaceDbPath,
        identity: empty.identity,
        emptyWindow: false,
      });

      assert.equal(
        current.selected.some((entry) => entry.storageId === 'empty'),
        false,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'a foreign write to the next chat is not absorbed by the new database token',
  { skip },
  async () => {
    const { root, ctx, one, empty, shared } = await profile();

    try {
      const prepared = await prepareManagedDelete(ctx, {
        kind: 'prepare-managed-delete',
        executable: ctx.executable,
        initFile: ctx.initFile,
        userDataRoot: root,
        requests: [
          { kind: 'workspace-data', workspace: one },
          { kind: 'workspace-data', workspace: shared },
        ],
        workspaces: [one, empty, shared],
        emptyWindow: true,
      });

      assert.equal(prepared.ok, true);
      if (!prepared.ok) return;

      let changed = false;

      const result = await observeTransfer(
        {
          event(entry) {
            if (
              entry.action === 'Delete chat' &&
              entry.status === 'completed' &&
              entry.chatId === A &&
              !changed
            ) {
              changed = true;

              execFileSync(executable!, [
                one.globalDbPath,
                `UPDATE cursorDiskKV SET value='{"newText":"changed after first commit"}' WHERE key='composerData:${B}';`,
              ]);
            }
          },
        },
        () =>
          executeManagedDelete(ctx, {
            kind: 'delete-managed-data',
            executable: ctx.executable,
            initFile: ctx.initFile,
            plan: prepared.plan,
            workspaces: [one, empty, shared],
            emptyWindow: true,
          }),
      );

      assert.equal(changed, true);
      assert.equal(result.outcomes[0]?.storage, 'deleted');
      assert.notEqual(result.outcomes[1]?.storage, 'deleted');

      const kept = await execSql({
        ...ctx,
        database: one.globalDbPath,
        readOnly: true,
        sql: `SELECT value FROM cursorDiskKV WHERE key='composerData:${B}';`,
      });

      assert.match(kept, /changed after first commit/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'an orphan bubble that references an image blocks workspace removal',
  { skip },
  async () => {
    const { root, ctx, one } = await profile();
    const uuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

    try {
      const images = attachmentDirectory(one);

      await mkdir(images, { recursive: true });
      await writeFile(path.join(images, `${uuid}.png`), 'image');

      await execSqlScript({
        ...ctx,
        database: one.globalDbPath,
        sql: `DELETE FROM cursorDiskKV WHERE key='composerData:${B}'; INSERT INTO cursorDiskKV VALUES('bubbleId:${B}:image',${sqlText(JSON.stringify({ images: [{ uuid }] }))});`,
      });

      const refusal = await foreignImageRefusal(ctx, one, [A]);

      assert.match(
        refusal || '',
        /referenced by another chat/,
        'No refusal although a foreign bubble references the image',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'an unrecognized composer version is not classified as empty',
  { skip },
  async () => {
    const { root, ctx, one } = await profile();

    try {
      await execSqlScript({
        ...ctx,
        database: one.globalDbPath,
        sql: `UPDATE cursorDiskKV SET value='{"_v":999,"futureMessages":[{"text":"keep"}]}' WHERE key='composerData:${A}'; DELETE FROM cursorDiskKV WHERE key='bubbleId:${A}:message';`,
      });

      assert.notEqual((await assessWorkspaceHistory(ctx, one)).state, 'empty');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'chat deletion removes exclusive chats and reports shared chats as skipped',
  { skip },
  async () => {
    const { root, ctx, one, empty, shared } = await profile();

    try {
      await execSqlScript({
        ...ctx,
        database: one.workspaceDbPath,
        sql: `UPDATE ItemTable SET value=${sqlText(JSON.stringify({ allComposers: [{ composerId: A }, { composerId: B }] }))} WHERE key='composer.composerData';`,
      });

      const prepared = await prepareManagedDelete(ctx, {
        kind: 'prepare-managed-delete',
        executable: ctx.executable,
        initFile: ctx.initFile,
        userDataRoot: root,
        requests: [{ kind: 'chats', workspace: one, ids: [A, B] }],
        workspaces: [one, empty, shared],
        emptyWindow: true,
      });

      assert.equal(prepared.ok, true);
      if (!prepared.ok) return;

      const result = await executeManagedDelete(ctx, {
        kind: 'delete-managed-data',
        executable: ctx.executable,
        initFile: ctx.initFile,
        plan: prepared.plan,
        workspaces: [one, empty, shared],
        emptyWindow: true,
      });

      assert.deepEqual(result.outcomes[0]?.chatIdsDeleted, [A]);
      assert.deepEqual(result.outcomes[0]?.chatIdsSkipped, [B]);

      const kept = await execSql({
        ...ctx,
        database: one.globalDbPath,
        readOnly: true,
        sql: `SELECT value FROM cursorDiskKV WHERE key='composerData:${B}';`,
      });

      assert.equal(kept.trim(), '{}');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

async function setupFamily(p: Awaited<ReturnType<typeof profile>>) {
  const headers = [
    {
      composerId: A,
      subagentComposerIds: [B],
      workspaceIdentifier: { id: 'one' },
    },
    {
      composerId: B,
      isSubagent: true,
      subagentInfo: {
        parentComposerId: A,
        rootParentConversationId: A,
      },
      workspaceIdentifier: { id: 'one' },
    },
  ];

  await execSqlScript({
    ...p.ctx,
    database: p.one.globalDbPath,
    sql: `UPDATE cursorDiskKV SET value=${sqlText(JSON.stringify({ _v: 13, composerId: A, fullConversationHeadersOnly: [], subagentComposerIds: [B] }))} WHERE key='composerData:${A}'; UPDATE cursorDiskKV SET value=${sqlText(JSON.stringify({ _v: 13, composerId: B, fullConversationHeadersOnly: [], subagentInfo: { parentComposerId: A, rootParentConversationId: A } }))} WHERE key='composerData:${B}'; UPDATE ItemTable SET value=${sqlText(JSON.stringify({ allComposers: headers }))} WHERE key='composer.composerHeaders';`,
  });

  await execSqlScript({
    ...p.ctx,
    database: p.one.workspaceDbPath,
    sql: `UPDATE ItemTable SET value=${sqlText(JSON.stringify({ allComposers: headers }))} WHERE key='composer.composerData';`,
  });

  await execSqlScript({
    ...p.ctx,
    database: p.shared.workspaceDbPath,
    sql: `UPDATE ItemTable SET value='{}' WHERE key='composer.composerData';`,
  });
}

test(
  'deleting a child keeps the parent and the fingerprint scope',
  { skip },
  async () => {
    const p = await profile();

    try {
      await setupFamily(p);

      const prepared = await prepareManagedDelete(p.ctx, {
        kind: 'prepare-managed-delete',
        ...p.ctx,
        userDataRoot: p.root,
        emptyWindow: true,
        workspaces: [p.one, p.empty, p.shared],
        requests: [{ workspace: p.one, kind: 'chats', ids: [B] }],
      });

      assert.equal(prepared.ok, true);
      if (!prepared.ok) return;

      const outcome = await executeManagedDelete(p.ctx, {
        kind: 'delete-managed-data',
        ...p.ctx,
        emptyWindow: true,
        workspaces: [p.one, p.empty, p.shared],
        plan: prepared.plan,
      });

      assert.equal(outcome.error, undefined, JSON.stringify(outcome));

      assert.equal(
        (
          await execSql({
            ...p.ctx,
            database: p.one.globalDbPath,
            sql: `SELECT count(*) FROM cursorDiskKV WHERE key='composerData:${B}';`,
          })
        ).trim(),
        '0',
      );
    } finally {
      await rm(p.root, { recursive: true, force: true });
    }
  },
);

test(
  'a parent-only request keeps the parent when a child remains',
  { skip },
  async () => {
    const p = await profile();

    try {
      await setupFamily(p);

      const prepared = await prepareManagedDelete(p.ctx, {
        kind: 'prepare-managed-delete',
        ...p.ctx,
        userDataRoot: p.root,
        emptyWindow: true,
        workspaces: [p.one, p.empty, p.shared],
        requests: [{ workspace: p.one, kind: 'chats', ids: [A] }],
      });

      assert.equal(prepared.ok, true);
      if (!prepared.ok) return;

      const outcome = await executeManagedDelete(p.ctx, {
        kind: 'delete-managed-data',
        ...p.ctx,
        emptyWindow: true,
        workspaces: [p.one, p.empty, p.shared],
        plan: prepared.plan,
      });

      assert.equal(
        (
          await execSql({
            ...p.ctx,
            database: p.one.globalDbPath,
            sql: `SELECT count(*) FROM cursorDiskKV WHERE key='composerData:${A}';`,
          })
        ).trim(),
        '1',
        JSON.stringify(outcome),
      );
    } finally {
      await rm(p.root, { recursive: true, force: true });
    }
  },
);

test(
  'export follows family links stored only on composer bodies',
  { skip },
  async () => {
    const p = await profile();

    try {
      await setupFamily(p);

      const headers = [
        { composerId: A, workspaceIdentifier: { id: 'one' } },
        { composerId: B, isSubagent: true, workspaceIdentifier: { id: 'one' } },
      ];

      for (const [database, key] of [
        [p.one.globalDbPath, 'composer.composerHeaders'],
        [p.one.workspaceDbPath, 'composer.composerData'],
      ] as const)
        await execSqlScript({
          ...p.ctx,
          database,
          sql: `UPDATE ItemTable SET value=${sqlText(JSON.stringify({ allComposers: headers }))} WHERE key=${sqlText(key)};`,
        });

      const { exportToFile } = await import('../src/export-transfer');
      const { readBundleObject } = await import('../src/bundle-object');
      const dest = path.join(p.root, 'family.zip');

      await exportToFile(p.ctx, p.one, dest, [A]);

      assert.equal((await readBundleObject(dest)).allComposers.length, 2);
    } finally {
      await rm(p.root, { recursive: true, force: true });
    }
  },
);
