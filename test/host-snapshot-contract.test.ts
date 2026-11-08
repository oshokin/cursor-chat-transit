import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  verifyHostRoot,
  UnsupportedHostSnapshotError,
  requireRendererFallback,
} from '../src/host-snapshot-contract';
import type { SqliteSession } from '../src/sqlite-session';

function fixture(header: Record<string, unknown>, scalars = Buffer.alloc(0)) {
  const json = Buffer.from(JSON.stringify(header));
  const root = Buffer.alloc(4 + json.length + scalars.length);

  root.writeUInt32LE(json.length);
  json.copy(root, 4);
  scalars.copy(root, 4 + json.length);
  const digest = createHash('sha256').update(root).digest('hex');
  const rows = new Map<string, Buffer>([[`agentKv:blob:${digest}`, root]]);

  const db = {
    rows: async (
      _sql: string,
      params: string[],
      visit: (row: unknown[]) => void,
    ) => {
      const value = rows.get(params[0]!);

      if (value !== undefined) visit([value]);
    },
  } as unknown as SqliteSession;

  const manifest = {
    manifestVersion: 2,
    latestRootBlobIdHex: digest,
    listHeads: { turns: 0, prompt: 0, archives: 0 },
  };

  return { db, manifest, rows, root };
}

const base = {
  version: 1,
  promptPrefix: [],
  summarySlot: [],
  body: [0, 0],
  turns: [0, 0],
  archives: [0, 0],
};

test('renderer fallback requires both unsupported native codec and complete renderer closure', () => {
  const unsupported = new UnsupportedHostSnapshotError('codec');

  assert.doesNotThrow(() => requireRendererFallback(unsupported, true));

  assert.throws(
    () => requireRendererFallback(unsupported, false),
    /complete renderer closure/,
  );

  for (const complete of [false, true]) {
    for (const corruption of [
      new Error('missing root'),
      new Error('hash mismatch'),
      new Error('invalid manifest'),
      new Error('schema'),
    ]) {
      assert.throws(
        () => requireRendererFallback(corruption, complete),
        (error: unknown) => error === corruption,
      );
    }
  }
});

test('installed linear root accepts empty committed ranges', async () => {
  const f = fixture(base);

  await verifyHostRoot(f.db, f.manifest);
});

test('linear roots reject bounds, heads, epoch and structure mismatch', async () => {
  for (const change of [
    { body: [1, 0] },
    { turns: [0, 1] },
    { archives: [0, 0x100000000] },
    { epoch: 1 },
    { structureId: 'ab'.repeat(32) },
  ]) {
    const f = fixture({ ...base, ...change });

    await assert.rejects(verifyHostRoot(f.db, f.manifest), /root/);
  }
});

test('missing committed list row and malformed row fail closed', async () => {
  const f = fixture({ ...base, body: [0, 1] });

  f.manifest.listHeads.prompt = 1;
  await assert.rejects(verifyHostRoot(f.db, f.manifest), /missing/);
  f.rows.set('agentHost:prompt:000000000000', Buffer.from('bad'));
  await assert.rejects(verifyHostRoot(f.db, f.manifest), /not a blob id/);
});

test('opaque protobuf and unknown structured closure are not complete', async () => {
  for (const bytes of [Buffer.from('opaque root'), Buffer.from([0x42, 0])]) {
    const f = fixture(base, bytes);

    await assert.rejects(verifyHostRoot(f.db, f.manifest));
  }
});

test('blob bytes must match content address', async () => {
  const f = fixture(base);

  f.root[0] = 0xff;
  await assert.rejects(verifyHostRoot(f.db, f.manifest), /hash mismatch/);
});

test('unsupported state is typed, but later malformed wire data is corruption', async () => {
  const unsupported = fixture(base, Buffer.from([0x42, 0]));

  await assert.rejects(
    verifyHostRoot(unsupported.db, unsupported.manifest),
    UnsupportedHostSnapshotError,
  );

  const corrupt = fixture(base, Buffer.from([0x42, 0, 0x0a, 0x20]));

  await assert.rejects(
    verifyHostRoot(corrupt.db, corrupt.manifest),
    (error: unknown) =>
      error instanceof Error &&
      !(error instanceof UnsupportedHostSnapshotError),
  );
});

test('unsupported turns cannot hide missing later prompt or malformed archive rows', async () => {
  const turn = Buffer.from('turn');
  const digest = createHash('sha256').update(turn).digest('hex');

  for (const archive of [false, true]) {
    const f = fixture({
      ...base,
      turns: [0, 1],
      ...(archive ? { archives: [0, 1] } : { body: [0, 1] }),
    });

    f.manifest.listHeads.turns = 1;
    f.manifest.listHeads[archive ? 'archives' : 'prompt'] = 1;
    f.rows.set('agentHost:turns:000000000000', Buffer.from(digest, 'hex'));
    f.rows.set(`agentKv:blob:${digest}`, turn);
    if (archive)
      f.rows.set('agentHost:archives:000000000000', Buffer.from('bad'));

    await assert.rejects(
      verifyHostRoot(f.db, f.manifest),
      (error: unknown) =>
        error instanceof Error &&
        !(error instanceof UnsupportedHostSnapshotError),
    );
  }
});

test('unsupported state cannot hide missing or corrupt direct blobs', async () => {
  const digest = 'ab'.repeat(32);

  const f = fixture(
    base,
    Buffer.concat([
      Buffer.from([0x42, 0, 0x0a, 32]),
      Buffer.from(digest, 'hex'),
    ]),
  );

  await assert.rejects(verifyHostRoot(f.db, f.manifest), /missing/);
  f.rows.set(`agentKv:blob:${digest}`, Buffer.from('corrupt'));
  await assert.rejects(verifyHostRoot(f.db, f.manifest), /hash mismatch/);
});

test('lastTurn references must exist before declaring unsupported closure', async () => {
  const f = fixture({ ...base, lastTurn: 'ab'.repeat(32) });

  await assert.rejects(verifyHostRoot(f.db, f.manifest), /missing/);
});
