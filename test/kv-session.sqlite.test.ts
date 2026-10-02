import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SqliteSession } from '../src/sqlite-session';
import { readSessionKv } from '../src/kv-session';
import { ensureInitFile, findSqliteExecutable, execSql } from '../src/sqlite';

/** Close the sqlite process before deleting its files. A failed first after-hook does not run the rest. */
async function removeFixture(
  session: SqliteSession | undefined,
  root: string,
): Promise<void> {
  try {
    await session?.close();
  } finally {
    await fs.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
  }
}

/** Build a database, then register cleanup only after the read session exists. */
async function openReadSession(
  t: { after(hook: () => Promise<void>): void },
  dirPrefix: string,
  sql: string,
): Promise<SqliteSession> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), dirPrefix));

  const options = {
    executable,
    database: path.join(root, 'kv.sqlite'),
    initFile: await ensureInitFile(root),
  };

  try {
    await execSql({ ...options, readOnly: false, sql });

    const session = await SqliteSession.open({ ...options, readOnly: true });

    t.after(() => removeFixture(session, root));

    return session;
  } catch (error) {
    await fs.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });

    throw error;
  }
}

const executable = findSqliteExecutable(process.env.SQLITE3_PATH)!;

test(
  'bounded KV reader preserves multi-chunk blobs, text with NUL and missing/empty values',
  { skip: !executable },
  async (t) => {
    const session = await openReadSession(
      t,
      'cct-kv-session-',
      `CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY, value);
    INSERT INTO cursorDiskKV VALUES ('large', zeroblob(3145735)), ('text', CAST(X'610062' AS TEXT)), ('empty', X'');`,
    );

    const large = await readSessionKv(session, 'large');

    assert.equal(large?.storageClass, 'blob');
    assert.deepEqual(large?.bytes, Buffer.alloc(3145735));

    assert.deepEqual(await readSessionKv(session, 'text'), {
      storageClass: 'text',
      bytes: Buffer.from([97, 0, 98]),
    });

    assert.deepEqual(await readSessionKv(session, 'empty'), {
      storageClass: 'blob',
      bytes: Buffer.alloc(0),
    });

    assert.equal(await readSessionKv(session, 'missing'), null);
    await assert.rejects(() => session.exec('DELETE FROM cursorDiskKV;'));
  },
);

test(
  'KV reader rejects an oversized value before emitting its payload',
  { skip: !executable },
  async (t) => {
    const session = await openReadSession(
      t,
      'cct-kv-large-',
      "CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY, value); INSERT INTO cursorDiskKV VALUES ('too-large', zeroblob(33554433));",
    );

    await assert.rejects(
      () => readSessionKv(session, 'too-large'),
      /exceeds 33554432 bytes/,
    );
  },
);

test(
  'batch KV reads preserve order, null/empty/text/blob values and bound total payload',
  { skip: !executable },
  async (t) => {
    const { readSessionKvBatch, KV_BATCH_BYTES } =
      await import('../src/kv-session');

    const session = await openReadSession(
      t,
      'cct-kv-batch-',
      `CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY,value); INSERT INTO cursorDiskKV VALUES ('text',CAST(X'610062' AS TEXT)),('empty',X''),('small',zeroblob(1024)),('large',zeroblob(${KV_BATCH_BYTES + 1})),('last',X'FF');`,
    );

    await session.exec('BEGIN;');
    const keys = ['missing', 'text', 'empty', 'small', 'large', 'last'];
    const first = await readSessionKvBatch(session, keys);

    assert.deepEqual([...first.keys()], keys.slice(0, 4));
    assert.equal(first.get('missing'), null);

    assert.deepEqual(first.get('text'), {
      storageClass: 'text',
      bytes: Buffer.from([97, 0, 98]),
    });

    assert.equal(first.get('empty')?.bytes.length, 0);
    assert.equal(first.get('small')?.bytes.length, 1024);
    const second = await readSessionKvBatch(session, keys.slice(4));

    assert.deepEqual([...second.keys()], ['large']);

    const largeBytes = second.get('large')?.bytes;

    assert.equal(largeBytes?.length, KV_BATCH_BYTES + 1);
    assert.equal(largeBytes?.includes(1), false);

    assert.deepEqual(
      (await readSessionKvBatch(session, ['last'])).get('last')?.bytes,
      Buffer.from([255]),
    );
  },
);

test(
  'batch KV reader rejects oversized and unsupported records before allocating payloads',
  { skip: !executable },
  async (t) => {
    const { readSessionKvBatch } = await import('../src/kv-session');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cct-kv-batch-bad-'));

    t.after(() => removeFixture(undefined, root));

    const options = {
      executable,
      database: path.join(root, 'kv.sqlite'),
      initFile: await ensureInitFile(root),
    };

    await execSql({
      ...options,
      readOnly: false,
      sql: "CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY,value); INSERT INTO cursorDiskKV VALUES('big',zeroblob(33554433)),('integer',42);",
    });

    for (const [key, error] of [
      ['big', /exceeds/],
      ['integer', /storage class/],
    ] as const) {
      const session = await SqliteSession.open({ ...options, readOnly: true });

      try {
        await assert.rejects(readSessionKvBatch(session, [key]), error);
      } finally {
        await session.close();
      }
    }
  },
);
