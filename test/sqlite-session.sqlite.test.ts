import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SqliteSession } from '../src/sqlite-session';
import { ensureInitFile, execSql, findSqliteExecutable } from '../src/sqlite';

const executable = findSqliteExecutable(process.env.SQLITE3_PATH)!;
const skip = !executable;

/** Temp directory removed when the test ends. */
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cct-session-'));

  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const options = {
    executable,
    database: path.join(dir, 'db.sqlite'),
    initFile: await ensureInitFile(dir),
  };

  await execSql({
    ...options,
    sql: 'PRAGMA journal_mode=WAL; CREATE TABLE t(x);',
    readOnly: false,
  });

  return options;
}

test(
  'session spawn failure rejects without an unhandled child error',
  { skip },
  async (t) => {
    const options = await fixture(t);

    await assert.rejects(
      () =>
        SqliteSession.open({
          ...options,
          executable: path.join(options.database, 'missing'),
        }),
      /ENOENT|ENOTDIR/,
    );
  },
);

test(
  'abort waits for SQLite exit and releases its uncommitted write lock',
  { skip },
  async (t) => {
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
  },
);

test(
  'session timeout rolls back its transaction and closes the writer',
  { skip },
  async (t) => {
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
  },
);

test(
  'a throwing row consumer rejects its request and releases SQLite',
  { skip },
  async (t) => {
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
  },
);
