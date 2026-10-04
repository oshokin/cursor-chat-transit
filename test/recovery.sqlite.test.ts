import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as db from '../src/db';
import * as sql from '../src/sqlite';
import * as transfer from '../src/transfer';
import { TransferError } from '../src/types';
import type {
  ExportObject,
  TransferContext,
  WorkspaceEntry,
} from '../src/types';

/** Complete chat in mixed-export fixtures. */
const A = '11111111-1111-4111-8111-111111111111';
/** Bubble belonging to the complete chat. */
const B = '22222222-2222-4222-8222-222222222222';
/** History-only chat missing a blob. */
const C = '33333333-3333-4333-8333-333333333333';
/** Unusable chat in mixed-export fixtures. */
const D = '44444444-4444-4444-8444-444444444444';
/** sqlite3 CLI used by these tests; undefined skips the suite. */
const executable = sql.findSqliteExecutable(process.env.SQLITE3_PATH);
/** Skip message when sqlite3 is not on PATH. */
const skip = executable ? false : 'sqlite3 CLI is required for recovery tests';

/** SHA-256 of bytes that are deliberately absent from storage. */
const digest = createHash('sha256').update('missing').digest('hex');

/** conversationState that names the missing blob. */
const state =
  '~' +
  Buffer.concat([
    Buffer.from([0x0a, 0x20]),
    Buffer.from(digest, 'hex'),
  ]).toString('base64');

/** Throwaway destination databases for recovery imports. */
async function setup(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cct-recovery-'));

  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const ctx: TransferContext = {
    executable: executable as string,
    initFile: await sql.ensureInitFile(dir),
  };

  const workspace: WorkspaceEntry = {
    storageRoot: dir,
    storageId: 'target',
    key: 'target',
    mtime: 0,
    identity: {
      kind: 'folder',
      uri: { scheme: 'file', authority: '', path: '/recovery' },
    },
    globalDbPath: path.join(dir, 'global.vscdb'),
    workspaceDbPath: path.join(dir, 'workspace.vscdb'),
  };

  const gl = { ...ctx, database: workspace.globalDbPath };
  const ws = { ...ctx, database: workspace.workspaceDbPath };

  await sql.execSqlScript({
    ...gl,
    sql: `PRAGMA journal_mode=WAL;
CREATE TABLE ItemTable(key TEXT PRIMARY KEY,value BLOB);
CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY,value BLOB);
INSERT INTO ItemTable VALUES('composer.composerHeaders','{"allComposers":[]}');`,
  });

  await sql.execSqlScript({
    ...ws,
    sql: 'PRAGMA journal_mode=WAL; CREATE TABLE ItemTable(key TEXT PRIMARY KEY,value BLOB);',
  });

  return { ctx, workspace, gl };
}

/** Mixed complete and history-only export used by recovery tests. */
function mixedExport(): ExportObject {
  return {
    formatVersion: 3,
    allComposers: [
      { composerId: A, name: 'Complete' },
      { composerId: C, name: 'History only' },
    ],
    composers: {
      [A]: JSON.stringify({
        _v: 18,
        composerId: A,
        name: 'Complete',
        fullConversationHeadersOnly: [{ bubbleId: B }],
      }),
      [C]: JSON.stringify({
        _v: 18,
        composerId: C,
        name: 'History only',
        conversationState: state,
        fullConversationHeadersOnly: [{ bubbleId: D }],
      }),
    },
    bubbles: {
      [A]: [
        {
          key: `bubbleId:${A}:${B}`,
          bubbleId: B,
          value: JSON.stringify({
            _v: 3,
            composerId: A,
            bubbleId: B,
            text: 'ok',
          }),
        },
      ],
      [C]: [
        {
          key: `bubbleId:${C}:${D}`,
          bubbleId: D,
          value: JSON.stringify({
            _v: 3,
            composerId: C,
            bubbleId: D,
            text: 'history',
          }),
        },
      ],
    },
    resources: { kv: [], attachments: [], plans: [] },
  };
}

test(
  'strict import still refuses a mixed complete/incomplete file',
  { skip },
  async (t) => {
    const { ctx, workspace, gl } = await setup(t);

    await assert.rejects(
      () => transfer.importFromObject(ctx, mixedExport(), workspace),
      (err: unknown) =>
        err instanceof TransferError && err.code === 'MISSING_DEPENDENCY',
    );

    const count = await sql.execSql({
      ...gl,
      sql: "SELECT count(*) FROM cursorDiskKV WHERE key GLOB 'composerData:*';",
    });

    assert.equal(count.trim(), '0');
  },
);

test(
  'allowPartial imports complete chats and history-only separately',
  { skip },
  async (t) => {
    const { ctx, workspace, gl } = await setup(t);

    const result = await transfer.importFromObject(
      ctx,
      mixedExport(),
      workspace,
      { allowPartial: true },
    );

    assert.equal(result.complete, 1);
    assert.equal(result.historyOnly, 1);
    assert.equal(result.skipped, 0);
    assert.equal(result.imported, 2);
    const names = [];

    for (const id of result.composerIds) {
      const body = JSON.parse(
        (await db.readKvText(gl, `composerData:${id}`)) || '{}',
      ) as { name?: string };

      names.push(body.name);
    }

    assert.deepEqual(names.sort(), ['Complete', 'History only']);
  },
);

test(
  'allowPartial does not treat a wholly unusable file as a zero-chat success',
  { skip },
  async (t) => {
    const { ctx, workspace, gl } = await setup(t);

    await assert.rejects(
      () =>
        transfer.importFromObject(
          ctx,
          {
            formatVersion: 3,
            allComposers: [{ composerId: A, name: 'Broken' }],
            composers: { [A]: '{not-json' },
            bubbles: { [A]: [] },
            resources: { kv: [], attachments: [], plans: [] },
          },
          workspace,
          { allowPartial: true },
        ),
      (err: unknown) =>
        err instanceof TransferError && err.code === 'NOTHING_TO_IMPORT',
    );

    const count = await sql.execSql({
      ...gl,
      sql: "SELECT count(*) FROM cursorDiskKV WHERE key GLOB 'composerData:*';",
    });

    assert.equal(count.trim(), '0');
  },
);

test(
  'allowPartial still rejects a forbidden resource key',
  { skip },
  async (t) => {
    const { ctx, workspace } = await setup(t);
    const obj = mixedExport();

    obj.resources = {
      kv: [
        {
          key: 'agentKv:other:00',
          value: {
            storageClass: 'blob',
            base64: Buffer.from('x').toString('base64'),
            byteLength: 1,
            sha256: createHash('sha256').update('x').digest('hex'),
          },
        },
      ],
      attachments: [],
      plans: [],
    };

    await assert.rejects(
      () =>
        transfer.importFromObject(ctx, obj, workspace, { allowPartial: true }),
      /not allowed/i,
    );
  },
);

/** The real on-disk import path, including the explicit consent boundary. */
async function recoveryArchive(
  t: { after: (fn: () => Promise<void>) => void },
  missingMessage = false,
) {
  const fixture = await setup(t);
  const obj = mixedExport();

  if (missingMessage) obj.bubbles![C] = [];
  const file = path.join(fixture.workspace.storageRoot, 'incomplete.zip');
  const { writeObjectBundle } = await import('../src/bundle-from-object');

  await writeObjectBundle(file, obj);

  return { ...fixture, file, obj };
}

test(
  'interactive recovery inspects all chats before consent and decline leaves Cursor unchanged',
  { skip },
  async (t) => {
    const { ctx, workspace, gl, file } = await recoveryArchive(t);
    const { importFromBundle } = await import('../src/import-bundle');

    const before = await sql.execSql({
      ...gl,
      sql: 'SELECT key,hex(value) FROM cursorDiskKV ORDER BY key;',
    });

    let asked = 0;

    await assert.rejects(
      () =>
        importFromBundle(ctx, file, workspace, {
          onRecovery: async (preview) => {
            asked++;
            assert.equal(preview.complete, 1);
            assert.equal(preview.historyOnly, 1);
            assert.equal(preview.skipped, 0);
            assert.equal(preview.missingResources.kv, 1);

            assert.equal(
              await sql.execSql({
                ...gl,
                sql: 'SELECT key,hex(value) FROM cursorDiskKV ORDER BY key;',
              }),
              before,
            );

            return false;
          },
        }),
      { name: 'AbortError' },
    );

    assert.equal(asked, 1);

    assert.equal(
      await sql.execSql({
        ...gl,
        sql: 'SELECT key,hex(value) FROM cursorDiskKV ORDER BY key;',
      }),
      before,
    );
  },
);

test(
  'missing-message chat is explicitly skipped while complete chat is recoverable; repeat is idempotent',
  { skip },
  async (t) => {
    const { ctx, workspace, gl, file } = await recoveryArchive(t, true);
    const { importFromBundle } = await import('../src/import-bundle');

    const options = {
      onRecovery: async (
        preview: import('../src/recovery-preview').RecoveryPreview,
      ) => {
        assert.equal(preview.historyOnly, 0);
        assert.equal(preview.skipped, 1);
        assert.match(preview.details[0]!, /History only: Missing message body/);

        return true;
      },
    };

    const first = await importFromBundle(ctx, file, workspace, options);

    assert.equal(first.imported, 1);
    assert.equal(first.skipped, 1);
    assert.notEqual(first.composerIds[0], A);

    assert.equal(
      (
        await sql.execSql({
          ...gl,
          sql: "SELECT count(*) FROM cursorDiskKV WHERE key GLOB 'composerData:*';",
        })
      ).trim(),
      '1',
    );

    const second = await importFromBundle(ctx, file, workspace, options);

    assert.equal(second.imported, 0);
    assert.equal(second.alreadyImported, 1);
  },
);

test(
  'recovery consent imports history with missing resources, without inventing message data',
  { skip },
  async (t) => {
    const { ctx, workspace, file } = await recoveryArchive(t);
    const { importFromBundle } = await import('../src/import-bundle');

    const result = await importFromBundle(ctx, file, workspace, {
      onRecovery: async () => true,
    });

    assert.equal(result.complete, 1);
    assert.equal(result.historyOnly, 1);
    assert.equal(result.imported, 2);
  },
);

test(
  'missing-message strict import fails with a typed reason before any publication',
  { skip },
  async (t) => {
    const { ctx, workspace, gl, file } = await recoveryArchive(t, true);
    const { importFromBundle } = await import('../src/import-bundle');

    await assert.rejects(
      () => importFromBundle(ctx, file, workspace),
      (error: unknown) =>
        error instanceof TransferError && error.code === 'MISSING_MESSAGE',
    );

    assert.equal(
      (
        await sql.execSql({ ...gl, sql: 'SELECT count(*) FROM cursorDiskKV;' })
      ).trim(),
      '0',
    );
  },
);

test(
  'a wholly unrecoverable bundle cannot report successful recovery even if approved',
  { skip },
  async (t) => {
    const { ctx, workspace, gl, obj, file } = await recoveryArchive(t, true);

    obj.allComposers = obj.allComposers.filter((chat) => chat.composerId === C);
    const { writeObjectBundle } = await import('../src/bundle-from-object');

    await writeObjectBundle(file, obj);
    const { importFromBundle } = await import('../src/import-bundle');

    await assert.rejects(
      () =>
        importFromBundle(ctx, file, workspace, {
          onRecovery: async (preview) => {
            assert.equal(preview.complete + preview.historyOnly, 0);
            assert.equal(preview.skipped, 1);

            return true;
          },
        }),
      (error: unknown) =>
        error instanceof TransferError && error.code === 'NOTHING_TO_IMPORT',
    );

    assert.equal(
      (
        await sql.execSql({ ...gl, sql: 'SELECT count(*) FROM cursorDiskKV;' })
      ).trim(),
      '0',
    );
  },
);

test('abort immediately after consent prevents writes', { skip }, async (t) => {
  const { ctx, workspace, gl, file } = await recoveryArchive(t);
  const { importFromBundle } = await import('../src/import-bundle');
  const abort = new AbortController();

  await assert.rejects(
    () =>
      importFromBundle({ ...ctx, signal: abort.signal }, file, workspace, {
        onRecovery: async () => {
          abort.abort();

          return true;
        },
      }),
    { name: 'AbortError' },
  );

  assert.equal(
    (
      await sql.execSql({ ...gl, sql: 'SELECT count(*) FROM cursorDiskKV;' })
    ).trim(),
    '0',
  );
});

test(
  'worker cancels while waiting for recovery consent and releases its import lock',
  { skip },
  async (t) => {
    const { ctx, workspace, gl, file } = await recoveryArchive(t);
    const { runTransfer } = await import('../src/transfer-process');
    const abort = new AbortController();

    await assert.rejects(
      () =>
        runTransfer(
          {
            kind: 'import',
            executable: ctx.executable!,
            initFile: ctx.initFile,
            workspace,
            filePath: file,
            interactiveRecovery: true,
          },
          {
            signal: abort.signal,
            onRecovery: async () => {
              abort.abort();

              return false;
            },
          },
        ),
      { name: 'AbortError' },
    );

    assert.equal(
      (
        await sql.execSql({ ...gl, sql: 'SELECT count(*) FROM cursorDiskKV;' })
      ).trim(),
      '0',
    );

    const { importFromBundle } = await import('../src/import-bundle');

    const retry = await importFromBundle(ctx, file, workspace, {
      onRecovery: async () => true,
    });

    assert.equal(retry.imported, 2);
  },
);

test(
  'export identifies missing message bodies in the source instead of declaring a complete archive',
  { skip },
  async (t) => {
    const { ctx, workspace, gl } = await setup(t);
    const { sqlText } = await import('../src/core');

    const body = JSON.stringify({
      composerId: A,
      fullConversationHeadersOnly: [{ bubbleId: B, type: 1 }],
      isNAL: false,
    });

    await sql.execSqlScript({
      ...gl,
      sql: `INSERT INTO cursorDiskKV VALUES(${sqlText(`composerData:${A}`)},${sqlText(body)}); UPDATE ItemTable SET value=${sqlText(JSON.stringify({ allComposers: [{ composerId: A, name: 'Missing messages', workspaceIdentifier: { id: workspace.storageId, uri: { scheme: 'file', path: '/recovery' } } }] }))} WHERE key='composer.composerHeaders';`,
    });

    const file = path.join(workspace.storageRoot, 'source.zip');
    const { exportToFile } = await import('../src/export-transfer');
    const result = await exportToFile(ctx, workspace, file, [A], true);

    assert.ok(result && !('skipped' in result));
    assert.equal(result.recoveryCandidates, 0);
    await assert.rejects(fs.stat(file), { code: 'ENOENT' });

    assert.ok(result && !('skipped' in result));
    assert.equal(result.complete, false);
    assert.equal(result.exported, 1);
    assert.equal(result.issues?.[0]?.reason, 'missing-messages');
    assert.equal(result.issues?.[0]?.missingMessages, 1);
    assert.equal(await db.readKvText(gl, `composerData:${A}`), body);
  },
);

test(
  'a complete recovery copy requires consent after inspection while ordinary complete import does not',
  { skip },
  async (t) => {
    const { ctx, workspace, gl, obj, file } = await recoveryArchive(t);

    obj.allComposers = obj.allComposers.filter((chat) => chat.composerId === A);
    const { writeObjectBundle } = await import('../src/bundle-from-object');

    await writeObjectBundle(file, obj);
    const { importFromBundle } = await import('../src/import-bundle');
    let asked = 0;

    await assert.rejects(
      () =>
        importFromBundle(ctx, file, workspace, {
          confirmCopy: true,
          onRecovery: async (preview) => {
            asked++;
            assert.equal(preview.complete, 1);
            assert.equal(preview.historyOnly + preview.skipped, 0);

            assert.equal(
              (
                await sql.execSql({
                  ...gl,
                  sql: 'SELECT count(*) FROM cursorDiskKV;',
                })
              ).trim(),
              '0',
            );

            return false;
          },
        }),
      { name: 'AbortError' },
    );

    assert.equal(asked, 1);

    const result = await importFromBundle(ctx, file, workspace, {
      onRecovery: async () => {
        throw new Error('Unnecessary consent');
      },
    });

    assert.equal(result.imported, 1);
  },
);

test(
  'recovery reuses export/import, creates new IDs, and preserves the selected source chat',
  { skip },
  async (t) => {
    const { ctx, workspace, gl, obj, file } = await recoveryArchive(t);

    obj.allComposers = obj.allComposers.filter((chat) => chat.composerId === A);
    const { writeObjectBundle } = await import('../src/bundle-from-object');

    await writeObjectBundle(file, obj);
    const { importFromBundle } = await import('../src/import-bundle');
    const original = await importFromBundle(ctx, file, workspace);
    const source = original.composerIds[0]!;
    const before = await db.readKvText(gl, `composerData:${source}`);
    const { exportToFile } = await import('../src/export-transfer');
    const copyFile = path.join(workspace.storageRoot, 'copy.zip');

    const assessed = await exportToFile(
      ctx,
      workspace,
      copyFile,
      [source],
      true,
    );

    assert.ok(!('skipped' in assessed));
    assert.equal(assessed.recoveryCandidates, 1);

    const recovered = await importFromBundle(ctx, copyFile, workspace, {
      confirmCopy: true,
      onRecovery: async () => true,
    });

    assert.equal(recovered.imported, 1);
    assert.notEqual(recovered.composerIds[0], source);
    assert.equal(await db.readKvText(gl, `composerData:${source}`), before);
    const sourceBubbles = await db.listBubbleIds(gl, source);
    const copiedBubbles = await db.listBubbleIds(gl, recovered.composerIds[0]!);

    assert.equal(copiedBubbles.size, 1);
    assert.notDeepEqual([...sourceBubbles], [...copiedBubbles]);
  },
);

test(
  'an invalid archive is not offered as recoverable',
  { skip },
  async (t) => {
    const { ctx, workspace, file } = await recoveryArchive(t);

    await fs.writeFile(file, 'not a zip');
    const { importFromBundle } = await import('../src/import-bundle');
    let asked = false;

    await assert.rejects(() =>
      importFromBundle(ctx, file, workspace, {
        onRecovery: async () => {
          asked = true;

          return true;
        },
      }),
    );

    assert.equal(asked, false);
  },
);

test(
  'declining recovery also defers cleanup of an earlier unpublished import',
  { skip },
  async (t) => {
    const { ctx, workspace, gl, file } = await recoveryArchive(t);
    const { JournalStore } = await import('../src/journal-db');
    const { targetKeyFor } = await import('../src/journal');
    const { sha256Text } = await import('../src/import-policy');
    const { sqlText } = await import('../src/core');
    const journalDir = path.join(workspace.storageRoot, 'journal');

    await fs.mkdir(journalDir);
    const targetKey = await targetKeyFor(workspace);

    const journal = await JournalStore.open({
      executable: ctx.executable,
      journalDir,
      targetKey,
    });

    const text = JSON.stringify({ text: 'Unpublished original data' });
    const key = `bubbleId:${D}:${B}`;

    try {
      await journal.beginPending({
        operationId: 'previous',
        phase: 'prepared',
      });

      await journal.addPendingChat('previous', {
        sourceComposerId: A,
        snapshotHash: 'a'.repeat(64),
        targetComposerId: D,
        expectedComposerHash: 'b'.repeat(64),
        bubbleCount: 1,
        quality: 'complete',
      });

      await journal.addPendingBubble('previous', D, B, sha256Text(text));
    } finally {
      await journal.close();
    }

    await sql.execSqlScript({
      ...gl,
      sql: `INSERT INTO cursorDiskKV VALUES(${sqlText(key)},${sqlText(text)});`,
    });

    const { importFromBundle } = await import('../src/import-bundle');

    await assert.rejects(
      () =>
        importFromBundle(ctx, file, workspace, {
          journalDir,
          onRecovery: async () => {
            assert.equal(await db.readKvText(gl, key), text);

            return false;
          },
        }),
      { name: 'AbortError' },
    );

    assert.equal(await db.readKvText(gl, key), text);

    const retained = await JournalStore.open({
      executable: ctx.executable,
      journalDir,
      targetKey,
    });

    try {
      assert.equal((await retained.pending())?.operationId, 'previous');
    } finally {
      await retained.close();
    }

    // Revalidate after the pause: a concurrent change must prevent cleanup, not be erased.
    await assert.rejects(
      () =>
        importFromBundle(ctx, file, workspace, {
          journalDir,
          onRecovery: async () => {
            await sql.execSqlScript({
              ...gl,
              sql: `UPDATE cursorDiskKV SET value='changed by Cursor' WHERE key=${sqlText(key)};`,
            });

            return true;
          },
        }),
      (error: unknown) =>
        error instanceof TransferError && error.code === 'NEEDS_ATTENTION',
    );

    assert.equal(await db.readKvText(gl, key), 'changed by Cursor');
  },
);

test(
  'recovery assessment counts complete and history-only chats during export, excluding empty and unknown sources',
  { skip },
  async (t) => {
    const { ctx, workspace, gl } = await setup(t);
    const { sqlText } = await import('../src/core');

    const headers = [A, C, D].map((composerId) => ({
      composerId,
      workspaceIdentifier: {
        id: workspace.storageId,
        uri: { scheme: 'file', path: '/recovery' },
      },
    }));

    await sql.execSqlScript({
      ...gl,
      sql: `UPDATE ItemTable SET value=${sqlText(JSON.stringify({ allComposers: headers }))} WHERE key='composer.composerHeaders';`,
    });

    for (const id of [A, C, D]) {
      const body = {
        composerId: id,
        fullConversationHeadersOnly: id === D ? [] : [{ bubbleId: B, type: 1 }],
        ...(id === C ? { conversationState: state } : {}),
      };

      await sql.execSqlScript({
        ...gl,
        sql: `INSERT INTO cursorDiskKV VALUES(${sqlText(`composerData:${id}`)},${sqlText(JSON.stringify(body))}); ${id === D ? '' : `INSERT INTO cursorDiskKV VALUES(${sqlText(`bubbleId:${id}:${B}`)},${sqlText(JSON.stringify({ bubbleId: B, type: 1, text: 'Fixture' }))});`}`,
      });
    }

    const { runTransfer } = await import('../src/transfer-process');

    const result = await runTransfer<{
      recoveryCandidates: number;
      exported: number;
    }>(
      {
        ...ctx,
        workspace,
        kind: 'export',
        filePath: path.join(workspace.storageRoot, 'assessed.zip'),
        assessRecovery: true,
      },
      {},
    );

    assert.equal(result.exported, 3);
    assert.equal(result.recoveryCandidates, 2);

    // An unrecognized ordered-message role must not lead to a destination prompt.
    await sql.execSqlScript({
      ...gl,
      sql: `UPDATE cursorDiskKV SET value=${sqlText(JSON.stringify({ composerId: A, fullConversationHeadersOnly: [{ bubbleId: B, type: 99 }] }))} WHERE key=${sqlText(`composerData:${A}`)};`,
    });

    const unknown = await runTransfer<{ recoveryCandidates: number }>(
      {
        ...ctx,
        workspace,
        kind: 'export',
        filePath: path.join(workspace.storageRoot, 'unknown.zip'),
        selectedIds: [A],
        assessRecovery: true,
      },
      {},
    );

    assert.equal(unknown.recoveryCandidates, 0);
  },
);

test(
  'partial text ZIP round-trip preserves full bodies, marks previews and gaps, and is idempotent',
  { skip },
  async (t) => {
    const { ctx, workspace, gl } = await setup(t);
    const { sqlText } = await import('../src/core');
    const { runTransfer } = await import('../src/transfer-process');
    const { importFromBundle } = await import('../src/import-bundle');

    const headers = [
      { bubbleId: B, type: 1, grouping: { textPreview: 'TRUNCATED' } },
      {
        bubbleId: C,
        type: 2,
        grouping: { textPreview: 'Available answer fragment' },
      },
      { bubbleId: D, type: 1 },
    ];

    const body = JSON.stringify({
      _v: 18,
      composerId: A,
      name: 'Partial history',
      fullConversationHeadersOnly: headers,
      isNAL: false,
    });

    const full = JSON.stringify({
      _v: 3,
      composerId: A,
      bubbleId: B,
      type: 1,
      text: 'Full original user message',
    });

    await sql.execSqlScript({
      ...gl,
      sql: `INSERT INTO cursorDiskKV VALUES (${sqlText(`composerData:${A}`)},${sqlText(body)}),(${sqlText(`bubbleId:${A}:${B}`)},${sqlText(full)}); UPDATE ItemTable SET value=${sqlText(JSON.stringify({ allComposers: [{ composerId: A, name: 'Partial history', workspaceIdentifier: { id: workspace.storageId } }] }))} WHERE key='composer.composerHeaders';`,
    });

    const file = path.join(workspace.storageRoot, 'partial-text.zip');

    const exported = await runTransfer<
      Awaited<ReturnType<typeof import('../src/export-transfer').exportToFile>>
    >(
      {
        kind: 'export',
        executable: ctx.executable!,
        initFile: ctx.initFile,
        workspace,
        filePath: file,
        selectedIds: [A],
        recoverText: true,
      },
      {},
    );

    assert.ok(!('skipped' in exported));
    assert.equal(exported.complete, false);
    assert.equal(exported.issues?.[0]?.reason, 'recovered-text');
    assert.equal(await db.readKvText(gl, `composerData:${A}`), body);
    assert.equal(await db.readKvText(gl, `bubbleId:${A}:${B}`), full);
    assert.equal(await db.readKvText(gl, `bubbleId:${A}:${C}`), null);
    let asked = 0;

    const options = {
      onRecovery: async (
        preview: import('../src/recovery-preview').RecoveryPreview,
      ) => {
        asked++;
        assert.equal(preview.historyOnly, 1);

        return true;
      },
    };

    const first = await importFromBundle(ctx, file, workspace, options);

    assert.equal(first.historyOnly, 1);
    assert.equal(first.imported, 1);
    assert.equal(asked, 1);
    const id = first.composerIds[0]!;
    const saved = JSON.parse((await db.readKvText(gl, `composerData:${id}`))!);

    assert.deepEqual(saved.cctTextRecovery, {
      version: 1,
      previews: 1,
      gaps: 1,
    });

    const texts: string[] = [];

    for (const header of saved.fullConversationHeadersOnly) {
      const bubble = JSON.parse(
        (await db.readKvText(gl, `bubbleId:${id}:${header.bubbleId}`))!,
      );

      texts.push(bubble.text);
      assert.equal(bubble.type, header.type);
    }

    assert.equal(texts[0], 'Full original user message');

    assert.match(
      texts[1]!,
      /Recovered from preview.*\n\nAvailable answer fragment/s,
    );

    assert.match(texts[2]!, /Message unavailable in the source/);
    const repeated = await importFromBundle(ctx, file, workspace, options);

    assert.equal(repeated.imported, 0);
    assert.equal(repeated.alreadyImported, 1);
  },
);

for (const scenario of [
  {
    name: 'disabled',
    recoverText: false,
    type: 1,
    preview: 'surviving preview',
    succeeds: false,
  },
  {
    name: 'unknown role',
    recoverText: true,
    type: 9,
    preview: 'surviving preview',
    succeeds: false,
  },
  {
    name: 'no surviving text',
    recoverText: true,
    type: 1,
    preview: '',
    succeeds: false,
  },
  {
    name: 'preview only',
    recoverText: true,
    type: 1,
    preview: 'surviving preview',
    succeeds: true,
  },
])
  test(`partial text recovery: ${scenario.name}`, { skip }, async (t) => {
    const { ctx, workspace, gl } = await setup(t);
    const { sqlText } = await import('../src/core');
    const { exportToFile } = await import('../src/export-transfer');
    const { importFromBundle } = await import('../src/import-bundle');

    const body = JSON.stringify({
      _v: 18,
      composerId: A,
      fullConversationHeadersOnly: [
        {
          bubbleId: B,
          type: scenario.type,
          grouping: { textPreview: scenario.preview },
        },
      ],
    });

    await sql.execSqlScript({
      ...gl,
      sql: `INSERT INTO cursorDiskKV VALUES (${sqlText(`composerData:${A}`)},${sqlText(body)}); UPDATE ItemTable SET value=${sqlText(JSON.stringify({ allComposers: [{ composerId: A, workspaceIdentifier: { id: workspace.storageId } }] }))} WHERE key='composer.composerHeaders';`,
    });

    const file = path.join(workspace.storageRoot, 'text.zip');

    await exportToFile(
      { ...ctx, recoverText: scenario.recoverText },
      workspace,
      file,
      [A],
    );

    if (scenario.succeeds) {
      const imported = await importFromBundle(ctx, file, workspace, {
        onRecovery: async () => true,
      });

      assert.equal(imported.historyOnly, 1);
    } else
      await assert.rejects(
        importFromBundle(ctx, file, workspace, {
          onRecovery: async () => true,
        }),
        (error: unknown) =>
          error instanceof TransferError && error.code === 'NOTHING_TO_IMPORT',
      );
    assert.equal(await db.readKvText(gl, `composerData:${A}`), body);
  });

for (const scenario of [
  'complete bodies',
  'existing empty body',
  'missing agent resource',
] as const)
  test(
    `recoverText leaves exported chat records unchanged with ${scenario}`,
    { skip },
    async (t) => {
      const { ctx, workspace, gl } = await setup(t);
      const { sqlText } = await import('../src/core');
      const { exportToFile } = await import('../src/export-transfer');
      const { openBundle } = await import('../src/bundle-reader');

      const body = {
        _v: 18,
        composerId: A,
        fullConversationHeadersOnly: [
          { bubbleId: B, type: 1, grouping: { textPreview: 'Short preview' } },
        ],
        ...(scenario === 'missing agent resource'
          ? { conversationState: state }
          : {}),
      };

      const bubble = {
        composerId: A,
        bubbleId: B,
        type: 1,
        text: scenario === 'existing empty body' ? '' : 'Full original message',
      };

      await sql.execSqlScript({
        ...gl,
        sql: `INSERT INTO cursorDiskKV VALUES (${sqlText(`composerData:${A}`)},${sqlText(JSON.stringify(body))}),(${sqlText(`bubbleId:${A}:${B}`)},${sqlText(JSON.stringify(bubble))}); UPDATE ItemTable SET value=${sqlText(JSON.stringify({ allComposers: [{ composerId: A, workspaceIdentifier: { id: workspace.storageId } }] }))} WHERE key='composer.composerHeaders';`,
      });

      const snapshots: Record<string, string>[] = [];

      for (const recoverText of [false, true]) {
        const file = path.join(
          workspace.storageRoot,
          `mode-${recoverText}.zip`,
        );

        await exportToFile({ ...ctx, recoverText }, workspace, file, [A]);
        const bundle = await openBundle(file);

        try {
          const root = path.join(bundle.root, 'chats');
          const records: Record<string, string> = {};

          for (const name of (
            await fs.readdir(root, { recursive: true })
          ).sort()) {
            const full = path.join(root, name);

            if ((await fs.stat(full)).isFile())
              records[name] = await fs.readFile(full, 'utf8');
          }

          assert.ok(Object.keys(records).length > 0);

          assert.equal(
            Object.values(records).some((text) =>
              text.includes('cctTextRecovery'),
            ),
            false,
          );

          snapshots.push(records);
        } finally {
          await bundle.close();
        }
      }

      assert.deepEqual(snapshots[1], snapshots[0]);

      assert.equal(
        await db.readKvText(gl, `composerData:${A}`),
        JSON.stringify(body),
      );

      assert.equal(
        await db.readKvText(gl, `bubbleId:${A}:${B}`),
        JSON.stringify(bubble),
      );
    },
  );
