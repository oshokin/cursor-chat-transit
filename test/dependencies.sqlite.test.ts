import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import * as db from '../src/db';
import { formatImportNotice } from '../src/operation-ui';
import { observeTransfer, type TransferEvent } from '../src/transfer-events';
import * as transfer from '../src/transfer';
import * as sql from '../src/sqlite';
import { sqlText } from '../src/core';
import { readJsonFile } from '../src/format';
import { encodeSqliteBytes, encodeAttachment } from '../src/dependencies';
import type {
  ExportObject,
  TransferContext,
  WorkspaceEntry,
  WorkspaceIdentity,
} from '../src/types';

/** Source composer used as the complete chat. */
const A = '11111111-1111-4111-8111-111111111111';
/** Bubble id referenced from composer A. */
const B = '22222222-2222-4222-8222-222222222222';
/** Second composer used in shared-blob tests. */
const C = '33333333-3333-4333-8333-333333333333';
/** Spare composer id. */
const D = '44444444-4444-4444-8444-444444444444';
/** Image UUID referenced from a bubble. */
const IMAGE = '01234567-89ab-4cde-8f01-23456789abcd';
/** sqlite3 CLI used by these tests; undefined skips the suite. */
const executable = sql.findSqliteExecutable(process.env.SQLITE3_PATH);

/** Skip message when sqlite3 is not on PATH. */
const skip = executable
  ? false
  : 'sqlite3 CLI is required for dependency tests';

/** Synthetic local workspace identity. */
const identity: WorkspaceIdentity = {
  kind: 'folder',
  uri: { scheme: 'file', authority: '', path: '/synthetic' },
};

/** Blob bytes stored under `blobKey`. */
const bytes = Buffer.from([0, 255, 128, 10, 65]);
/** SHA-256 of `bytes`. */
const digest = createHash('sha256').update(bytes).digest('hex');
/** `cursorDiskKV` key for the fixture blob. */
const blobKey = `agentKv:blob:${digest}`;

/** Field-1 conversationState that names `digest`. */
const state =
  '~' +
  Buffer.concat([
    Buffer.from([0x0a, 0x20]),
    Buffer.from(digest, 'hex'),
  ]).toString('base64');

/** One-pixel PNG used as an attachment. */
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c4944415408d763f8cfc000000003000118dd8db00000000049454e44ae426082',
  'hex',
);

/** Composer body JSON, optionally carrying conversationState. */
function composerBody(id: string, conversationState?: string) {
  return JSON.stringify({
    _v: 18,
    composerId: id,
    name: 'Dependency fixture',
    conversationState,
    fullConversationHeadersOnly: [{ bubbleId: B }],
  });
}

/** Bubble JSON for `B`, with optional extra image fields. */
function bubbleValue(composerId: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    _v: 3,
    composerId,
    bubbleId: B,
    text: 'Synthetic fixture',
    ...extra,
  });
}

/** Throwaway global/workspace SQLite pair for dependency tests. */
async function fixture(
  t: { after: (fn: () => Promise<void>) => void },
  name = 'pair',
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `cct-dep-${name}-`));

  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const plansDir = path.join(root, 'plans');

  await fs.mkdir(plansDir);

  const ctx: TransferContext = {
    executable: executable as string,
    initFile: await sql.ensureInitFile(root),
    plansDir,
  };

  /** Create one empty global/workspace SQLite pair under `folder`. */
  async function make(folder: string) {
    const dir = path.join(root, folder);

    await fs.mkdir(dir);

    const workspace: WorkspaceEntry = {
      storageRoot: dir,
      storageId: folder,
      key: folder,
      mtime: 0,
      identity,
      globalDbPath: path.join(dir, 'global.vscdb'),
      workspaceDbPath: path.join(dir, 'workspace.vscdb'),
    };

    const gl = { ...ctx, database: workspace.globalDbPath };
    const ws = { ...ctx, database: workspace.workspaceDbPath };

    await sql.execSqlScript({
      ...gl,
      sql: 'CREATE TABLE ItemTable(key TEXT PRIMARY KEY,value BLOB); CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY,value BLOB);',
    });

    await sql.execSqlScript({
      ...ws,
      sql: 'CREATE TABLE ItemTable(key TEXT PRIMARY KEY,value BLOB);',
    });

    return { workspace, gl, ws };
  }

  return {
    root,
    ctx,
    plansDir,
    source: await make('source'),
    target: await make('target'),
  };
}

/** Insert one composer body, header, and bubble into the source databases. */
async function seedChat(
  gl: TransferContext & { database: string },
  ws: TransferContext & { database: string },
  opts: {
    id?: string;
    bubbleId?: string;
    state?: string;
    images?: unknown;
    blob?: boolean;
    extra?: Record<string, unknown>;
    bubbleText?: string;
  } = {},
) {
  const id = opts.id || A;
  const bubbleId = opts.bubbleId || B;

  await sql.execSqlScript({
    ...gl,
    sql: db.kvInsertSql([
      {
        key: `composerData:${id}`,
        value: JSON.stringify({
          _v: 18,
          composerId: id,
          name: 'Dependency fixture',
          conversationState: opts.state,
          fullConversationHeadersOnly: [{ bubbleId }],
          ...opts.extra,
        }),
      },
      {
        key: `bubbleId:${id}:${bubbleId}`,
        value: JSON.stringify({
          _v: 3,
          composerId: id,
          bubbleId,
          text: opts.bubbleText || 'Synthetic fixture',
          ...(opts.images ? { images: opts.images } : {}),
        }),
      },
    ]),
  });

  if (opts.blob) {
    await sql.execSqlScript({
      ...gl,
      sql: `INSERT INTO cursorDiskKV VALUES (${sqlText(blobKey)}, X'${bytes.toString('hex')}');`,
    });
  }

  await sql.execSqlScript({
    ...ws,
    sql: db.itemReplaceSql('composer.composerData', {
      allComposers: [{ composerId: id, name: 'Dependency fixture' }],
    }),
  });
}

test(
  'export/import preserves a reachable agentKv blob byte-for-byte',
  { skip },
  async (t) => {
    const { root, ctx, source, target } = await fixture(t);

    await seedChat(source.gl, source.ws, { state, blob: true });
    const dest = path.join(root, 'export.json');

    await transfer.exportToFile(ctx, source.workspace, dest);

    const exported = (await readJsonFile(dest)) as {
      allComposers: unknown[];
      resources: { kv: Array<{ key: string }> };
      summary: { complete: boolean };
    };

    assert.equal(exported.allComposers.length, 1);
    assert.equal(exported.summary.complete, true);
    assert.equal(exported.resources.kv.length, 1);
    assert.equal(exported.resources.kv[0].key, blobKey);
    await transfer.importFromObject(ctx, exported, target.workspace);

    const stored = await sql.execSql({
      ...target.gl,
      sql: `SELECT hex(value) FROM cursorDiskKV WHERE key='${blobKey}';`,
    });

    assert.equal(stored.trim(), bytes.toString('hex').toUpperCase());

    const kind = await sql.execSql({
      ...target.gl,
      sql: `SELECT typeof(value) FROM cursorDiskKV WHERE key='${blobKey}';`,
    });

    assert.equal(kind.trim(), 'blob');
  },
);

test(
  'export with an absent required blob must not report complete=true',
  { skip },
  async (t) => {
    const { root, ctx, source } = await fixture(t);

    await seedChat(source.gl, source.ws, { state, blob: false });
    const dest = path.join(root, 'incomplete.json');
    const result = await transfer.exportToFile(ctx, source.workspace, dest);

    assert.equal(
      result && 'complete' in result && result.complete,
      false,
      'composer/bubble presence alone is not completeness',
    );
  },
);

test('two chats sharing a blob export it once', { skip }, async (t) => {
  const { root, ctx, source } = await fixture(t);

  await seedChat(source.gl, source.ws, {
    id: A,
    bubbleId: B,
    state,
    blob: true,
  });

  await seedChat(source.gl, source.ws, {
    id: C,
    bubbleId: D,
    state,
    blob: false,
  });

  await sql.execSqlScript({
    ...source.ws,
    sql: db.itemReplaceSql('composer.composerData', {
      allComposers: [
        { composerId: A, name: 'Dependency fixture' },
        { composerId: C, name: 'Dependency fixture' },
      ],
    }),
  });

  const dest = path.join(root, 'shared.json');

  await transfer.exportToFile(ctx, source.workspace, dest);

  const exported = (await readJsonFile(dest)) as {
    resources: { kv: unknown[] };
    allComposers: unknown[];
  };

  assert.equal(exported.allComposers.length, 2);
  assert.equal(exported.resources.kv.length, 1);
});

test(
  'legacy JSON can reuse a blob already in the target',
  { skip },
  async (t) => {
    const { ctx, target } = await fixture(t);

    await sql.execSqlScript({
      ...target.gl,
      sql: `INSERT INTO cursorDiskKV VALUES (${sqlText(blobKey)}, X'${bytes.toString('hex')}');`,
    });

    const obj = {
      formatVersion: 2,
      allComposers: [{ composerId: A, name: 'Legacy' }],
      composers: { [A]: composerBody(A, state) },
      bubbles: {
        [A]: [
          {
            key: `bubbleId:${A}:${B}`,
            bubbleId: B,
            value: bubbleValue(A),
          },
        ],
      },
    };

    const result = await transfer.importFromObject(ctx, obj, target.workspace);

    assert.equal(result.imported, 1);
  },
);

test(
  'incomplete resources are rejected before composer metadata is published',
  { skip },
  async (t) => {
    const { ctx, target } = await fixture(t);

    const obj = {
      formatVersion: 3,
      allComposers: [{ composerId: A, name: 'Incomplete' }],
      composers: { [A]: composerBody(A, state) },
      bubbles: {
        [A]: [
          {
            key: `bubbleId:${A}:${B}`,
            bubbleId: B,
            value: bubbleValue(A),
          },
        ],
      },
      resources: { kv: [], attachments: [], plans: [] },
    };

    await assert.rejects(
      () => transfer.importFromObject(ctx, obj, target.workspace),
      (err: unknown) =>
        err instanceof TransferError && err.code === 'MISSING_DEPENDENCY',
    );

    const count = await sql.execSql({
      ...target.gl,
      sql: "SELECT count(*) FROM cursorDiskKV WHERE key GLOB 'composerData:*';",
    });

    assert.equal(count.trim(), '0');
  },
);

test(
  'unknown conversation state is rejected before write',
  { skip },
  async (t) => {
    const { root, ctx, source } = await fixture(t);

    await seedChat(source.gl, source.ws);

    await sql.execSqlScript({
      ...source.gl,
      sql: `UPDATE cursorDiskKV SET value = ${sqlText(
        JSON.stringify({
          _v: 99,
          composerId: A,
          conversationState: '~',
          fullConversationHeadersOnly: [{ bubbleId: B }],
        }),
      )} WHERE key = ${sqlText(`composerData:${A}`)};`,
    });

    const dest = path.join(root, 'unsupported.json');

    await assert.rejects(
      () => transfer.exportToFile(ctx, source.workspace, dest),
      (err: unknown) =>
        err instanceof TransferError && err.code === 'UNSUPPORTED_STATE',
    );
  },
);

test(
  'same key with different bytes is a conflict and leaves the original',
  { skip },
  async (t) => {
    const { root, ctx, source, target } = await fixture(t);

    await seedChat(source.gl, source.ws, { state, blob: true });

    await sql.execSqlScript({
      ...target.gl,
      sql: `INSERT INTO cursorDiskKV VALUES (${sqlText(blobKey)}, X'11');`,
    });

    const dest = path.join(root, 'conflict.json');

    await transfer.exportToFile(ctx, source.workspace, dest);
    const exported = await readJsonFile(dest);
    const events: TransferEvent[] = [];

    const result = await observeTransfer(
      { event: (event) => events.push(event) },
      () => transfer.importFromObject(ctx, exported, target.workspace),
    );

    assert.equal(result.imported, 0);
    assert.equal(result.skipped, 1);
    assert.equal(result.skippedChats[0]?.composerId, A);

    assert.match(
      result.skippedChats[0]?.reason || '',
      /stored resource differs/,
    );

    const conflict = events.find((event) => event.detail?.includes('reason='));

    assert.match(conflict?.detail || '', /phase=preflight/);
    assert.match(conflict?.detail || '', /reason=content/);
    assert.match(conflict?.detail || '', /existingClass=blob/);
    assert.match(conflict?.detail || '', /incomingClass=blob/);
    assert.match(conflict?.detail || '', /keyMatchesExisting=false/);
    assert.match(conflict?.detail || '', /keyMatchesIncoming=true/);
    assert.equal(conflict?.key, blobKey);

    const stored = await sql.execSql({
      ...target.gl,
      sql: `SELECT hex(value) FROM cursorDiskKV WHERE key='${blobKey}';`,
    });

    assert.equal(stored.trim(), '11');
  },
);

test(
  'identical blob bytes and storage class are reused',
  { skip },
  async (t) => {
    const { root, ctx, source, target } = await fixture(t);

    await seedChat(source.gl, source.ws, { state, blob: true });

    await sql.execSqlScript({
      ...target.gl,
      sql: `INSERT INTO cursorDiskKV VALUES (${sqlText(blobKey)}, X'${bytes.toString('hex')}');`,
    });

    const dest = path.join(root, 'same.json');

    await transfer.exportToFile(ctx, source.workspace, dest);

    const result = await transfer.importFromObject(
      ctx,
      await readJsonFile(dest),
      target.workspace,
    );

    assert.equal(result.imported, 1);
    assert.equal(result.skipped, 0);

    const stored = await sql.execSql({
      ...target.gl,
      sql: `SELECT typeof(value) || ' ' || hex(value) || ' ' || count(*) FROM cursorDiskKV WHERE key='${blobKey}';`,
    });

    assert.equal(
      stored.trim(),
      `blob ${bytes.toString('hex').toUpperCase()} 1`,
    );
  },
);

test(
  'same blob bytes with a different storage class stay untouched',
  { skip },
  async (t) => {
    const { root, ctx, source, target } = await fixture(t);

    await seedChat(source.gl, source.ws, { state, blob: true });

    await sql.execSqlScript({
      ...target.gl,
      sql: `INSERT INTO cursorDiskKV VALUES (${sqlText(blobKey)}, CAST(X'${bytes.toString('hex')}' AS TEXT));`,
    });

    const dest = path.join(root, 'class.json');

    await transfer.exportToFile(ctx, source.workspace, dest);
    const events: TransferEvent[] = [];

    const exported = await readJsonFile(dest);

    const result = await observeTransfer(
      { event: (event) => events.push(event) },
      () => transfer.importFromObject(ctx, exported, target.workspace),
    );

    assert.equal(result.imported, 0);
    assert.equal(result.skipped, 1);

    assert.match(
      events.find((event) => event.detail?.includes('phase=preflight'))
        ?.detail || '',
      /reason=storage-class/,
    );

    const stored = await sql.execSql({
      ...target.gl,
      sql: `SELECT typeof(value) || ' ' || hex(value) FROM cursorDiskKV WHERE key='${blobKey}';`,
    });

    assert.equal(stored.trim(), `text ${bytes.toString('hex').toUpperCase()}`);
  },
);

test(
  'hex text of an addressed blob is restored to the raw blob',
  { skip },
  async (t) => {
    const { root, ctx, source, target } = await fixture(t);

    await seedChat(source.gl, source.ws, { state, blob: true });

    await sql.execSqlScript({
      ...target.gl,
      sql: `INSERT INTO cursorDiskKV VALUES (${sqlText(blobKey)}, ${sqlText(bytes.toString('hex'))});`,
    });

    const dest = path.join(root, 'hex.json');

    await transfer.exportToFile(ctx, source.workspace, dest);
    const exported = await readJsonFile(dest);
    const events: TransferEvent[] = [];

    const result = await observeTransfer(
      { event: (event) => events.push(event) },
      () => transfer.importFromObject(ctx, exported, target.workspace),
    );

    assert.equal(result.imported, 1);
    assert.equal(result.skipped, 0);

    assert.equal(
      events.filter((event) => event.action === 'Restore hex-encoded blob')
        .length,
      1,
    );

    const stored = await sql.execSql({
      ...target.gl,
      sql: `SELECT typeof(value) || ' ' || hex(value) FROM cursorDiskKV WHERE key='${blobKey}';`,
    });

    assert.equal(stored.trim(), `blob ${bytes.toString('hex').toUpperCase()}`);

    const repeated = await transfer.importFromObject(
      ctx,
      exported,
      target.workspace,
    );

    assert.equal(repeated.imported, 0);
    assert.equal(repeated.alreadyImported, 1);
  },
);

test('hex text of different bytes stays a conflict', { skip }, async (t) => {
  const { root, ctx, source, target } = await fixture(t);

  await seedChat(source.gl, source.ws, { state, blob: true });

  await sql.execSqlScript({
    ...target.gl,
    sql: `INSERT INTO cursorDiskKV VALUES (${sqlText(blobKey)}, '09');`,
  });

  const dest = path.join(root, 'hex-other.json');

  await transfer.exportToFile(ctx, source.workspace, dest);

  const result = await transfer.importFromObject(
    ctx,
    await readJsonFile(dest),
    target.workspace,
  );

  assert.equal(result.imported, 0);
  assert.equal(result.skipped, 1);

  const stored = await sql.execSql({
    ...target.gl,
    sql: `SELECT typeof(value) || ' ' || value FROM cursorDiskKV WHERE key='${blobKey}';`,
  });

  assert.equal(stored.trim(), 'text 09');
});

test(
  'a conflicting first chat does not block the other chats',
  { skip },
  async (t) => {
    const { root, ctx, source, target } = await fixture(t);
    const third = '55555555-5555-4555-8555-555555555555';
    const bubbleC = '66666666-6666-4666-8666-666666666666';
    const bubbleThird = '77777777-7777-4777-8777-777777777777';

    await seedChat(source.gl, source.ws, {
      id: A,
      state,
      blob: true,
      extra: { name: 'RocksDB and gRPC update' },
    });

    await seedChat(source.gl, source.ws, {
      id: C,
      bubbleId: bubbleC,
      extra: { name: 'Second chat' },
    });

    await seedChat(source.gl, source.ws, {
      id: third,
      bubbleId: bubbleThird,
      extra: { name: 'Third chat' },
    });

    await sql.execSqlScript({
      ...source.ws,
      sql: db.itemReplaceSql('composer.composerData', {
        allComposers: [
          { composerId: A, name: 'RocksDB and gRPC update' },
          { composerId: C, name: 'Second chat' },
          { composerId: third, name: 'Third chat' },
        ],
      }),
    });

    await sql.execSqlScript({
      ...target.gl,
      sql: `INSERT INTO cursorDiskKV VALUES (${sqlText(blobKey)}, X'11');`,
    });

    const dest = path.join(root, 'three.json');

    await transfer.exportToFile(ctx, source.workspace, dest);

    const attempted: number[] = [];

    const first = await transfer.importFromBundle(
      {
        ...ctx,
        onPhase(_phase, metrics) {
          if (metrics?.chatIndex && attempted.at(-1) !== metrics.chatIndex)
            attempted.push(metrics.chatIndex);
        },
      },
      dest,
      target.workspace,
    );

    assert.deepEqual(attempted, [1, 2, 3]);

    const notice = formatImportNotice(first);

    assert.equal(first.imported, 2);
    assert.equal(first.skipped, 1);
    assert.equal(first.skippedChats[0]?.composerId, A);
    assert.match(notice.title, /Imported 2 chats/);
    assert.match(notice.detail, /1 chat was skipped/);

    assert.ok(
      notice.items.some((item) =>
        item.includes('RocksDB and gRPC update — a stored resource differs'),
      ),
    );

    const again = await transfer.importFromBundle(ctx, dest, target.workspace);

    assert.equal(again.imported, 0);
    assert.equal(again.alreadyImported, 2);
    assert.equal(again.skipped, 1);

    await sql.execSqlScript({
      ...target.gl,
      sql: `UPDATE cursorDiskKV SET value = X'${bytes.toString('hex')}' WHERE key = ${sqlText(blobKey)};`,
    });

    const retried = await transfer.importFromBundle(
      ctx,
      dest,
      target.workspace,
    );

    assert.equal(retried.imported, 1);
    assert.equal(retried.alreadyImported, 2);
    assert.equal(retried.skipped, 0);

    const composers = await sql.execSql({
      ...target.gl,
      sql: `SELECT count(*) FROM cursorDiskKV WHERE key LIKE 'composerData:%';`,
    });

    assert.equal(composers.trim(), '3');
  },
);

test(
  'a blob changed between the check and the write is not replaced',
  { skip },
  async (t) => {
    const { root, ctx, source, target } = await fixture(t);

    await seedChat(source.gl, source.ws, { state, blob: true });

    await sql.execSqlScript({
      ...target.gl,
      sql: `INSERT INTO cursorDiskKV VALUES (${sqlText(blobKey)}, X'${bytes.toString('hex')}');`,
    });

    const dest = path.join(root, 'race.json');

    await transfer.exportToFile(ctx, source.workspace, dest);
    const exported = await readJsonFile(dest);
    let changed = false;

    await assert.rejects(
      () =>
        transfer.importFromObject(
          {
            ...ctx,
            onPhase(phase, metrics) {
              if (changed || phase !== 'write' || metrics?.chats !== 1) return;
              changed = true;

              execFileSync(executable as string, [
                target.workspace.globalDbPath,
                `UPDATE cursorDiskKV SET value = X'22' WHERE key = ${sqlText(blobKey)};`,
              ]);
            },
          },
          exported,
          target.workspace,
        ),
      (err: unknown) =>
        err instanceof TransferError &&
        err.code === 'RESOURCE_CONFLICT' &&
        typeof err.detail === 'string' &&
        err.detail.includes('phase=write') &&
        err.detail.includes('reason=content'),
    );

    const stored = await sql.execSql({
      ...target.gl,
      sql: `SELECT hex(value) FROM cursorDiskKV WHERE key='${blobKey}';`,
    });

    assert.equal(stored.trim(), '22');

    const composers = await sql.execSql({
      ...target.gl,
      sql: `SELECT count(*) FROM cursorDiskKV WHERE key LIKE 'composerData:%';`,
    });

    assert.equal(composers.trim(), '0');
  },
);

test('a tiny PNG round-trips into workspace images/', { skip }, async (t) => {
  const { root, ctx, source, target } = await fixture(t);

  const images = path.join(
    path.dirname(source.workspace.workspaceDbPath),
    'images',
  );

  await fs.mkdir(images);
  await fs.writeFile(path.join(images, `${IMAGE}.png`), PNG);

  await seedChat(source.gl, source.ws, {
    images: [{ uuid: IMAGE, dimension: { width: 1, height: 1 } }],
  });

  const dest = path.join(root, 'image.json');
  const result = await transfer.exportToFile(ctx, source.workspace, dest);

  assert.equal(result && 'complete' in result && result.complete, true);
  const exported = (await readJsonFile(dest)) as ExportObject;

  assert.equal(exported.resources?.attachments.length, 1);
  await transfer.importFromObject(ctx, exported, target.workspace);

  const copied = await fs.readFile(
    path.join(
      path.dirname(target.workspace.workspaceDbPath),
      'images',
      `${IMAGE}.png`,
    ),
  );

  assert.deepEqual(copied, PNG);
});

test(
  'missing image makes export incomplete and import refuse metadata',
  { skip },
  async (t) => {
    const { root, ctx, source, target } = await fixture(t);

    await seedChat(source.gl, source.ws, {
      images: [{ uuid: IMAGE, dimension: { width: 1, height: 1 } }],
    });

    const dest = path.join(root, 'no-image.json');
    const result = await transfer.exportToFile(ctx, source.workspace, dest);

    assert.equal(result && 'complete' in result && result.complete, false);
    const exported = await readJsonFile(dest);

    await assert.rejects(
      () => transfer.importFromObject(ctx, exported, target.workspace),
      (err: unknown) =>
        err instanceof TransferError && err.code === 'MISSING_DEPENDENCY',
    );
  },
);

test(
  'attachment symlink outside the images directory is rejected',
  { skip },
  async (t) => {
    const { root, ctx, source } = await fixture(t);
    const outside = path.join(root, 'outside.png');

    await fs.writeFile(outside, PNG);

    const images = path.join(
      path.dirname(source.workspace.workspaceDbPath),
      'images',
    );

    await fs.mkdir(images);
    await fs.symlink(outside, path.join(images, `${IMAGE}.png`));

    await seedChat(source.gl, source.ws, {
      images: [{ uuid: IMAGE, dimension: { width: 1, height: 1 } }],
    });

    const dest = path.join(root, 'symlink.json');

    await assert.rejects(() =>
      transfer.exportToFile(ctx, source.workspace, dest),
    );
  },
);

test(
  'bad attachment checksum is rejected before metadata is written',
  { skip },
  async (t) => {
    const { ctx, target } = await fixture(t);
    const att = encodeAttachment(IMAGE, PNG, 'png');

    att.sha256 = '00'.repeat(32);

    const obj = {
      formatVersion: 3,
      allComposers: [{ composerId: A, name: 'Bad' }],
      composers: { [A]: composerBody(A) },
      bubbles: {
        [A]: [
          {
            key: `bubbleId:${A}:${B}`,
            bubbleId: B,
            value: bubbleValue(A, {
              images: [{ uuid: IMAGE, dimension: { width: 1, height: 1 } }],
            }),
          },
        ],
      },
      resources: { kv: [], attachments: [att] },
    };

    await assert.rejects(
      () => transfer.importFromObject(ctx, obj, target.workspace),
      /checksum/i,
    );

    const count = await sql.execSql({
      ...target.gl,
      sql: "SELECT count(*) FROM cursorDiskKV WHERE key GLOB 'composerData:*';",
    });

    assert.equal(count.trim(), '0');
  },
);

test(
  'typed text with NUL is stored as TEXT, not UTF-8-reencoded',
  { skip },
  async (t) => {
    const { ctx, target } = await fixture(t);
    const raw = Buffer.from([0, 255, 9, 65]);
    const envelope = encodeSqliteBytes(raw, 'text');
    const digestText = createHash('sha256').update(raw).digest('hex');
    const key = `agentKv:blob:${digestText}`;

    const textState =
      '~' +
      Buffer.concat([
        Buffer.from([0x0a, 0x20]),
        Buffer.from(digestText, 'hex'),
      ]).toString('base64');

    const obj = {
      formatVersion: 3,
      allComposers: [{ composerId: A, name: 'Text blob' }],
      composers: { [A]: composerBody(A, textState) },
      bubbles: {
        [A]: [
          {
            key: `bubbleId:${A}:${B}`,
            bubbleId: B,
            value: bubbleValue(A),
          },
        ],
      },
      resources: { kv: [{ key, value: envelope }], attachments: [], plans: [] },
    };

    await transfer.importFromObject(ctx, obj, target.workspace);

    const kind = await sql.execSql({
      ...target.gl,
      sql: `SELECT typeof(value) FROM cursorDiskKV WHERE key=${sqlText(key)};`,
    });

    assert.equal(kind.trim(), 'text');

    const hex = await sql.execSql({
      ...target.gl,
      sql: `SELECT hex(CAST(value AS BLOB)) FROM cursorDiskKV WHERE key=${sqlText(key)};`,
    });

    assert.equal(hex.trim(), raw.toString('hex').toUpperCase());
  },
);

/** Allowlisted plan basename used in plan-import tests. */
const PLAN_NAME = 'c++23_hello_world_9740ba02.plan.md';
/** Plan markdown stored under that basename. */
const PLAN_MARKDOWN = '# C++23 Hello World\n\nDo the thing.\n';
/** Deliberately evil file URI that must not be followed. */
const PLAN_MARKER = `file:///evil-export-path/${PLAN_NAME}`;

/** Read the imported composer JSON from the destination global database. */
async function readImportedComposer(
  ctx: TransferContext,
  workspace: WorkspaceEntry,
) {
  const listed = await transfer.listWorkspaceChats(ctx, workspace);

  assert.equal(listed.allComposers.length, 1);
  const id = listed.allComposers[0]!.composerId;

  const body = await db.readKvText(
    {
      executable: ctx.executable,
      database: workspace.globalDbPath,
      initFile: ctx.initFile,
      readOnly: true,
    },
    `composerData:${id}`,
  );

  assert.ok(body);

  const parsed = JSON.parse(body) as {
    planUri?: string;
    text?: string;
  };

  let bubbleText = '';

  await db.forEachBubble(
    {
      executable: ctx.executable,
      database: workspace.globalDbPath,
      initFile: ctx.initFile,
      readOnly: true,
    },
    id,
    (bubble) => {
      bubbleText = JSON.parse(bubble.value).text;
    },
  );

  return { parsed, bubbleText };
}

test(
  'export copies a plan from plansDir by basename, never the JSON path',
  { skip },
  async (t) => {
    const { root, ctx, source } = await fixture(t);
    const sourcePlans = path.join(root, 'source-plans');
    const evil = path.join(root, 'evil-export-path');

    await fs.mkdir(sourcePlans);
    await fs.mkdir(evil);
    await fs.writeFile(path.join(sourcePlans, PLAN_NAME), PLAN_MARKDOWN);
    await fs.writeFile(path.join(evil, PLAN_NAME), 'must-not-copy\n');

    await seedChat(source.gl, source.ws, {
      extra: { planUri: PLAN_MARKER },
      bubbleText: `see ${PLAN_MARKER}`,
    });

    const dest = path.join(root, 'plan.json');

    const result = await transfer.exportToFile(
      { ...ctx, plansDir: sourcePlans },
      source.workspace,
      dest,
    );

    assert.equal(result && 'complete' in result && result.complete, true);

    const exported = (await readJsonFile(dest)) as {
      resources: { plans: Array<{ filename: string; base64: string }> };
    };

    assert.equal(exported.resources.plans.length, 1);
    assert.equal(exported.resources.plans[0]!.filename, PLAN_NAME);

    assert.equal(
      Buffer.from(exported.resources.plans[0]!.base64, 'base64').toString(),
      PLAN_MARKDOWN,
    );
  },
);

test(
  'export does not follow a planUri path outside plansDir',
  { skip },
  async (t) => {
    const { root, ctx, source } = await fixture(t);
    const sourcePlans = path.join(root, 'source-plans');
    const evil = path.join(root, 'evil-export-path');

    await fs.mkdir(sourcePlans);
    await fs.mkdir(evil);
    await fs.writeFile(path.join(evil, PLAN_NAME), PLAN_MARKDOWN);

    await seedChat(source.gl, source.ws, {
      extra: { planUri: pathToFileURL(path.join(evil, PLAN_NAME)).href },
    });

    const dest = path.join(root, 'missing-plan.json');

    const result = await transfer.exportToFile(
      { ...ctx, plansDir: sourcePlans },
      source.workspace,
      dest,
    );

    assert.equal(result && 'complete' in result && result.complete, false);

    const exported = (await readJsonFile(dest)) as {
      resources: { plans: unknown[] };
      summary: { issues: Array<{ missingPlans?: number }> };
    };

    assert.equal(exported.resources.plans.length, 0);
    assert.equal(exported.summary.issues[0]?.missingPlans, 1);
  },
);

test(
  'export/import round-trips a plan file and rewrites structured planUri',
  { skip },
  async (t) => {
    const { root, ctx, source, target } = await fixture(t);
    const sourcePlans = path.join(root, 'source-plans');
    const targetPlans = path.join(root, 'target-plans');

    await fs.mkdir(sourcePlans);
    await fs.mkdir(targetPlans);
    await fs.writeFile(path.join(sourcePlans, PLAN_NAME), PLAN_MARKDOWN);

    await seedChat(source.gl, source.ws, {
      extra: { planUri: PLAN_MARKER },
      bubbleText: `see ${PLAN_MARKER}`,
    });

    const dest = path.join(root, 'plan-roundtrip.json');

    await transfer.exportToFile(
      { ...ctx, plansDir: sourcePlans },
      source.workspace,
      dest,
    );

    const exported = await readJsonFile(dest);

    await transfer.importFromObject(
      { ...ctx, plansDir: targetPlans },
      exported,
      target.workspace,
    );

    const copied = await fs.readFile(path.join(targetPlans, PLAN_NAME), 'utf8');

    assert.equal(copied, PLAN_MARKDOWN);

    const { parsed, bubbleText } = await readImportedComposer(
      { ...ctx, plansDir: targetPlans },
      target.workspace,
    );

    assert.equal(
      parsed.planUri,
      pathToFileURL(path.join(targetPlans, PLAN_NAME)).href,
    );

    assert.equal(bubbleText, `see ${PLAN_MARKER}`);
  },
);

test(
  'missing plan is incomplete; allowPartial imports history-only',
  { skip },
  async (t) => {
    const { root, ctx, source, target } = await fixture(t);
    const sourcePlans = path.join(root, 'source-plans');
    const targetPlans = path.join(root, 'target-plans');

    await fs.mkdir(sourcePlans);
    await fs.mkdir(targetPlans);

    await seedChat(source.gl, source.ws, {
      extra: { planUri: PLAN_MARKER },
    });

    const dest = path.join(root, 'no-plan.json');

    const exportedPath = await transfer.exportToFile(
      { ...ctx, plansDir: sourcePlans },
      source.workspace,
      dest,
    );

    assert.equal(
      exportedPath && 'complete' in exportedPath && exportedPath.complete,
      false,
    );

    const exported = await readJsonFile(dest);

    await assert.rejects(
      () =>
        transfer.importFromObject(
          { ...ctx, plansDir: targetPlans },
          exported,
          target.workspace,
        ),
      (err: unknown) =>
        err instanceof TransferError && err.code === 'MISSING_DEPENDENCY',
    );

    const recovered = await transfer.importFromObject(
      { ...ctx, plansDir: targetPlans },
      exported,
      target.workspace,
      { allowPartial: true },
    );

    assert.equal(recovered.imported, 1);
    assert.equal(recovered.historyOnly, 1);
    assert.equal(recovered.complete, 0);
    await assert.rejects(fs.access(path.join(targetPlans, PLAN_NAME)));
  },
);

test(
  'same plan bytes are reused; different dest bytes conflict',
  { skip },
  async (t) => {
    const { root, ctx, source, target } = await fixture(t);
    const sourcePlans = path.join(root, 'source-plans');
    const targetPlans = path.join(root, 'target-plans');

    await fs.mkdir(sourcePlans);
    await fs.mkdir(targetPlans);
    await fs.writeFile(path.join(sourcePlans, PLAN_NAME), PLAN_MARKDOWN);

    await seedChat(source.gl, source.ws, {
      extra: { planUri: PLAN_MARKER },
    });

    const dest = path.join(root, 'plan-conflict.json');

    await transfer.exportToFile(
      { ...ctx, plansDir: sourcePlans },
      source.workspace,
      dest,
    );

    const exported = await readJsonFile(dest);

    await fs.writeFile(path.join(targetPlans, PLAN_NAME), PLAN_MARKDOWN);

    const reused = await transfer.importFromObject(
      { ...ctx, plansDir: targetPlans },
      exported,
      target.workspace,
    );

    assert.equal(reused.imported, 1);
    const other = await fixture(t, 'conflict');

    await seedChat(other.source.gl, other.source.ws, {
      extra: { planUri: PLAN_MARKER },
    });

    await fs.writeFile(
      path.join(other.root, 'plans', PLAN_NAME),
      PLAN_MARKDOWN,
    );

    const otherDest = path.join(other.root, 'other.json');

    await transfer.exportToFile(other.ctx, other.source.workspace, otherDest);
    const otherExported = await readJsonFile(otherDest);

    await fs.mkdir(path.join(other.root, 'target-plans'));

    await fs.writeFile(
      path.join(other.root, 'target-plans', PLAN_NAME),
      'different\n',
    );

    await assert.rejects(
      () =>
        transfer.importFromObject(
          { ...other.ctx, plansDir: path.join(other.root, 'target-plans') },
          otherExported,
          other.target.workspace,
        ),
      (err: unknown) =>
        err instanceof TransferError && err.code === 'RESOURCE_CONFLICT',
    );

    assert.equal(
      await fs.readFile(
        path.join(other.root, 'target-plans', PLAN_NAME),
        'utf8',
      ),
      'different\n',
    );
  },
);

test(
  'format 2 can reuse a plan already on the destination',
  { skip },
  async (t) => {
    const { root, ctx, target } = await fixture(t);
    const targetPlans = path.join(root, 'target-plans');

    await fs.mkdir(targetPlans);
    await fs.writeFile(path.join(targetPlans, PLAN_NAME), PLAN_MARKDOWN);

    const obj = {
      formatVersion: 2,
      allComposers: [{ composerId: A, name: 'Legacy plan' }],
      composers: {
        [A]: JSON.stringify({
          _v: 18,
          composerId: A,
          name: 'Legacy plan',
          planUri: PLAN_MARKER,
          fullConversationHeadersOnly: [{ bubbleId: B }],
        }),
      },
      bubbles: {
        [A]: [
          {
            key: `bubbleId:${A}:${B}`,
            bubbleId: B,
            value: bubbleValue(A),
          },
        ],
      },
    };

    const result = await transfer.importFromObject(
      { ...ctx, plansDir: targetPlans },
      obj,
      target.workspace,
    );

    assert.equal(result.imported, 1);
    assert.equal(result.complete, 1);

    const { parsed } = await readImportedComposer(
      { ...ctx, plansDir: targetPlans },
      target.workspace,
    );

    assert.equal(
      parsed.planUri,
      pathToFileURL(path.join(targetPlans, PLAN_NAME)).href,
    );
  },
);

test(
  'object and file exports preserve the same selected chat, resources and missing-body result',
  { skip },
  async (t) => {
    const { root, ctx, source } = await fixture(t);

    await seedChat(source.gl, source.ws, { state, blob: true });

    await sql.execSqlScript({
      ...source.ws,
      sql: db.itemReplaceSql('composer.composerData', {
        allComposers: [
          { composerId: A, name: 'Dependency fixture' },
          { composerId: C, name: 'Missing body' },
        ],
      }),
    });

    const object = await transfer.buildExportObject(ctx, source.workspace, [
      A,
      C,
    ]);

    const phases: Array<{
      chats?: number;
      processed?: number;
      total?: number;
    }> = [];

    const notes: string[] = [];

    ctx.onPhase = (phase, metrics) => {
      if (phase === 'read') phases.push(metrics || {});
    };

    ctx.onNote = (note) => notes.push(note);
    const dest = path.join(root, 'same-export.json');

    await transfer.exportToFile(ctx, source.workspace, dest, [A, C]);
    const file = (await readJsonFile(dest)) as ExportObject;

    assert.deepEqual(file.allComposers, object.allComposers);
    assert.deepEqual(file.composers, object.composers);
    assert.deepEqual(file.bubbles, object.bubbles);
    assert.deepEqual(file.resources, object.resources);
    assert.deepEqual(file.summary?.incomplete, [C]);
    assert.deepEqual(file.summary?.incomplete, object.summary?.incomplete);
    assert.equal(file.summary?.complete, false);

    assert.deepEqual(phases, [
      {
        chatName: 'Dependency fixture',
        chatIndex: 1,
        chatTotal: 2,
        processed: 0,
        total: 1,
        unit: 'messages',
      },
      {
        chatName: 'Dependency fixture',
        chatIndex: 1,
        chatTotal: 2,
        processed: 1,
        total: 1,
        unit: 'messages',
      },
      {
        chatName: 'Missing body',
        chatIndex: 2,
        chatTotal: 2,
        processed: 0,
        total: 0,
        unit: 'messages',
      },
    ]);

    assert.ok(
      notes.some((note) => note.includes(C) && note.includes('missing-body')),
    );
  },
);

/** Second uuid Cursor appends when it rewrites a chat image. */
const IMAGE_VARIANT = '2ea3d901-6f02-4fa8-84ea-bfdfcc8f8b70';

test(
  'identical uuid-variant copies collapse; import keeps that basename',
  { skip },
  async (t) => {
    const { root, ctx, source, target } = await fixture(t);

    const images = path.join(
      path.dirname(source.workspace.workspaceDbPath),
      'images',
    );

    await fs.mkdir(images);
    await fs.writeFile(path.join(images, `${IMAGE}-${IMAGE_VARIANT}.png`), PNG);

    await fs.writeFile(
      path.join(images, `${IMAGE}-230d1375-9223-4c76-a987-c86655c1afc8.png`),
      PNG,
    );

    await seedChat(source.gl, source.ws, {
      images: [{ uuid: IMAGE, dimension: { width: 1, height: 1 } }],
    });

    const dest = path.join(root, 'variant-image.json');
    const result = await transfer.exportToFile(ctx, source.workspace, dest);

    assert.equal(result && 'complete' in result && result.complete, true);
    const exported = (await readJsonFile(dest)) as ExportObject;

    assert.equal(exported.resources?.attachments.length, 1);

    const storedName = exported.resources?.attachments[0]?.filename as string;

    assert.ok(storedName.startsWith(`${IMAGE}-`));
    assert.equal(exported.resources?.attachments[0]?.aliases?.length, 1);
    await transfer.importFromObject(ctx, exported, target.workspace);

    const copied = await fs.readFile(
      path.join(
        path.dirname(target.workspace.workspaceDbPath),
        'images',
        storedName,
      ),
    );

    assert.deepEqual(copied, PNG);
  },
);

/** Canvas basename copied from the project canvases directory. */
const CANVAS_NAME = 'dos-conan-migration-map.canvas.tsx';

/** Canvas source that must round-trip. */
const CANVAS_SOURCE =
  'export default function DosConanMigrationMap(){return null}\n';

test(
  'export copies a canvas from canvasesDir and import rewrites the URI',
  { skip },
  async (t) => {
    const { root, ctx, source, target } = await fixture(t);
    const sourceCanvases = path.join(root, 'source-canvases');
    const targetCanvases = path.join(root, 'target-canvases');
    const evil = path.join(root, 'evil', 'canvases');

    await fs.mkdir(sourceCanvases);
    await fs.mkdir(targetCanvases);
    await fs.mkdir(evil, { recursive: true });
    await fs.writeFile(path.join(sourceCanvases, CANVAS_NAME), CANVAS_SOURCE);
    await fs.writeFile(path.join(evil, CANVAS_NAME), 'must-not-copy\n');

    const marker = path.join(evil, CANVAS_NAME);

    await seedChat(source.gl, source.ws, {
      extra: {
        uri: {
          scheme: 'file',
          path: marker,
          external: pathToFileURL(marker).href,
        },
      },
      bubbleText: `see ${marker}`,
    });

    const dest = path.join(root, 'canvas.json');

    const result = await transfer.exportToFile(
      { ...ctx, canvasesDir: sourceCanvases },
      source.workspace,
      dest,
    );

    assert.equal(result && 'complete' in result && result.complete, true);

    const exported = (await readJsonFile(dest)) as {
      resources: { canvases: Array<{ filename: string; base64: string }> };
    };

    assert.equal(exported.resources.canvases.length, 1);
    assert.equal(exported.resources.canvases[0]!.filename, CANVAS_NAME);

    assert.equal(
      Buffer.from(exported.resources.canvases[0]!.base64, 'base64').toString(),
      CANVAS_SOURCE,
    );

    await transfer.importFromObject(
      { ...ctx, canvasesDir: targetCanvases },
      exported,
      target.workspace,
    );

    assert.equal(
      await fs.readFile(path.join(targetCanvases, CANVAS_NAME), 'utf8'),
      CANVAS_SOURCE,
    );

    const { parsed, bubbleText } = await readImportedComposer(
      { ...ctx, canvasesDir: targetCanvases },
      target.workspace,
    );

    const destCanvas = path.join(targetCanvases, CANVAS_NAME);

    const uri = (parsed as { uri?: { path?: string; fsPath?: string } }).uri;

    assert.equal(
      uri?.path,
      decodeURIComponent(pathToFileURL(destCanvas).pathname),
    );

    assert.equal(uri?.fsPath, destCanvas);
    assert.equal(bubbleText, `see ${marker}`);
  },
);

import { TransferError } from '../src/types';

test(
  'hex repair preserves a row changed after preflight or immediately before its transaction',
  { skip },
  async (t) => {
    for (const moment of ['after-preflight', 'before-update']) {
      const { root, ctx, source, target } = await fixture(t, moment);

      await seedChat(source.gl, source.ws, { state, blob: true });

      await sql.execSqlScript({
        ...target.gl,
        sql: `INSERT INTO cursorDiskKV VALUES (${sqlText(blobKey)}, ${sqlText(bytes.toString('hex'))});`,
      });

      const dest = path.join(root, 'repair-race.zip');

      await transfer.exportToFile(ctx, source.workspace, dest);
      let changed = false;

      const mutate = () => {
        if (changed) return;
        changed = true;

        execFileSync(executable as string, [
          target.workspace.globalDbPath,
          `UPDATE cursorDiskKV SET value = 'different' WHERE key = ${sqlText(blobKey)};`,
        ]);
      };

      const result = await observeTransfer(
        {
          event(event) {
            if (
              moment === 'before-update' &&
              event.action === 'Write file' &&
              event.status === 'completed' &&
              event.path?.endsWith('/decoded.bin')
            )
              mutate();
          },
        },
        () =>
          transfer.importFromBundle(
            {
              ...ctx,
              onPhase(_phase, metrics) {
                if (
                  moment === 'after-preflight' &&
                  metrics?.scope === 'assertKvCompatible' &&
                  metrics.processed === metrics.total
                )
                  mutate();
              },
            },
            dest,
            target.workspace,
          ),
      );

      assert.equal(changed, true, moment);
      assert.equal(result.imported, 0, moment);
      assert.equal(result.skipped, 1, moment);

      assert.equal(
        (
          await sql.execSql({
            ...target.gl,
            sql: `SELECT typeof(value) || ':' || value FROM cursorDiskKV WHERE key = ${sqlText(blobKey)};`,
          })
        ).trim(),
        'text:different',
      );

      assert.equal(
        (
          await sql.execSql({
            ...target.gl,
            sql: "SELECT count(*) FROM cursorDiskKV WHERE key LIKE 'composerData:%';",
          })
        ).trim(),
        '0',
      );
    }
  },
);
