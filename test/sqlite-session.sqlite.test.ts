import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SqliteSession } from '../src/sqlite-session';
import { execSql } from '../src/sqlite';

/** Temp directory removed when the test ends. */
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cct-session-'));

  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const options = {
    database: path.join(dir, 'db.sqlite'),
  };

  await execSql({
    ...options,
    sql: 'PRAGMA journal_mode=WAL; CREATE TABLE t(x);',
    readOnly: false,
  });

  return options;
}

test('native open failure rejects without an unhandled worker error', async (t) => {
  const options = await fixture(t);

  await assert.rejects(
    () =>
      SqliteSession.open({
        ...options,
        database: path.join(options.database, 'missing'),
        readOnly: true,
      }),
    /exist|open/i,
  );
});

test('abort waits for SQLite exit and releases its uncommitted write lock', async (t) => {
  const options = await fixture(t);
  const controller = new AbortController();

  const session = await SqliteSession.open({
    ...options,
    signal: controller.signal,
  });

  await session.exec('BEGIN IMMEDIATE; INSERT INTO t VALUES(1);');
  controller.abort();
  await session.close();

  await execSql({
    ...options,
    readOnly: false,
    busyTimeoutMs: 0,
    sql: 'BEGIN IMMEDIATE; INSERT INTO t VALUES(2); COMMIT;',
  });

  assert.equal(
    (
      await execSql({
        ...options,
        sql: 'SELECT group_concat(x) FROM t;',
        readOnly: true,
      })
    ).trim(),
    '2',
  );
});

test('repeated stop signals remain idempotent until the child closes', async (t) => {
  const options = await fixture(t);
  const controller = new AbortController();

  const session = await SqliteSession.open({
    ...options,
    signal: controller.signal,
  });

  const query = session.exec(
    'WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000000000) SELECT sum(x) FROM n;',
  );

  const rejected = assert.rejects(query, /cancel/i);

  controller.abort(new Error('Cancelled'));
  await session.close();
  await rejected;

  await execSql({
    ...options,
    readOnly: false,
    busyTimeoutMs: 0,
    sql: 'BEGIN IMMEDIATE; INSERT INTO t VALUES(3); COMMIT;',
  });
});

test('session timeout rolls back its transaction and closes the writer', async (t) => {
  const options = await fixture(t);
  const session = await SqliteSession.open({ ...options, timeoutMs: 200 });

  await session.exec('BEGIN IMMEDIATE; INSERT INTO t VALUES(1);');

  await assert.rejects(
    () =>
      session.exec(
        'WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000000000) SELECT sum(x) FROM n;',
      ),
    /timed out/,
  );

  await session.close();

  await execSql({
    ...options,
    readOnly: false,
    busyTimeoutMs: 0,
    sql: 'BEGIN IMMEDIATE; INSERT INTO t VALUES(2); COMMIT;',
  });
});

test('a throwing row consumer rejects its request and releases SQLite', async (t) => {
  const options = await fixture(t);
  const session = await SqliteSession.open(options);

  await assert.rejects(
    () =>
      session.queryLines('SELECT 1;', () => {
        throw new Error('consumer failed');
      }),
    /consumer failed/,
  );

  await session.close();
});

test('async row consumers apply backpressure and finish before the next request', async (t) => {
  const options = await fixture(t);
  const session = await SqliteSession.open(options);
  let active = 0;
  let maximum = 0;
  let count = 0;

  try {
    await session.queryLines(
      'WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<2000) SELECT x FROM n;',
      async (line) => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(Number(line), count + 1);
        count += 1;
        active -= 1;
      },
    );

    assert.equal(maximum, 1);
    assert.equal(count, 2000);
    assert.equal((await session.exec('SELECT 7;')).trim(), '7');

    await assert.rejects(
      () =>
        session.queryLines('SELECT 1;', async () => {
          await new Promise<void>((resolve) => setImmediate(resolve));

          throw new Error('async consumer failed');
        }),
      /async consumer failed/,
    );
  } finally {
    await session.close();
  }
});

test('abort drains SQLite and waits for an active async consumer before returning', async (t) => {
  const options = await fixture(t);
  const controller = new AbortController();

  const session = await SqliteSession.open({
    ...options,
    signal: controller.signal,
  });

  let release!: () => void;
  let entered!: () => void;

  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve;
  });

  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  let settled = false;

  const query = session
    .queryLines(
      'WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<100000) SELECT x FROM n;',
      async () => {
        entered();
        await gate;
      },
    )
    .finally(() => {
      settled = true;
    });

  // Attach rejection handling before aborting to exercise the real cancellation path.
  const rejected = assert.rejects(() => query, /Cancelled/);

  await enteredPromise;
  controller.abort(new Error('Cancelled'));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  release();
  await rejected;
  await session.close();
});

test('large values use bounded spill IPC in both directions', async (t) => {
  const options = await fixture(t);
  const session = await SqliteSession.open(options);
  const bytes = Buffer.alloc(33 * 1024 * 1024, 0x5a);

  try {
    await session.rows(
      'INSERT INTO t VALUES(?) RETURNING x;',
      [bytes],
      (row) => {
        assert.ok(Buffer.isBuffer(row[0]));
        assert.equal((row[0] as Buffer).length, bytes.length);
        assert.equal((row[0] as Buffer).subarray(-1)[0], 0x5a);
      },
    );
  } finally {
    await session.close();
  }
});

test('row packets stay backpressured before producing the next batch', async (t) => {
  const options = await fixture(t);
  const session = await SqliteSession.open(options);
  let release!: () => void;

  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  let entered!: () => void;

  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve;
  });

  let consumed = 0;

  const query = session.rows(
    'WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<130) SELECT x FROM n;',
    [],
    async () => {
      consumed += 1;

      if (consumed === 1) {
        entered();
        await gate;
      }
    },
  );

  await enteredPromise;
  assert.equal(consumed, 1);
  release();
  await query;
  assert.equal(consumed, 130);
  await session.close();
});
