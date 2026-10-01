import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  findSqliteExecutable,
  ensureInitFile,
  execSql,
  execSqlScript,
} from '../src/sqlite';
import { bubbleRange } from '../src/core';

/** sqlite3 CLI used by these tests; undefined skips the suite. */
const executable = findSqliteExecutable();
/** Skip message when sqlite3 is not on PATH. */
const skip = executable ? false : 'sqlite3 CLI is required for these tests';

/** Create a throwaway sqlite3 database for one test. */
async function dbFixture(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cct-sql-'));

  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const database = path.join(dir, 'test.vscdb');
  const initFile = await ensureInitFile(dir);

  const conn = {
    executable: executable as string,
    database,
    initFile,
    readOnly: false,
    timeoutMs: 15000,
  };

  return { dir, conn };
}

test('EXPLAIN range query uses the key index', { skip }, async (t) => {
  const { conn } = await dbFixture(t);

  await execSqlScript({
    ...conn,
    sql: `CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB);
INSERT INTO cursorDiskKV VALUES ('bubbleId:11111111-1111-4111-8111-111111111111:a', '1');
INSERT INTO cursorDiskKV VALUES ('bubbleId:11111111-1111-4111-8111-111111111111:b', '2');
INSERT INTO cursorDiskKV VALUES ('other', '3');`,
  });

  const { lower, upper } = bubbleRange('11111111-1111-4111-8111-111111111111');

  const rangePlan = await execSql({
    ...conn,
    sql: `EXPLAIN QUERY PLAN SELECT key FROM cursorDiskKV WHERE key >= '${lower}' AND key < '${upper}';`,
    readOnly: true,
  });

  assert.match(rangePlan, /SEARCH cursorDiskKV USING (?:COVERING )?INDEX/i);
});

test(
  'SQL failure before COMMIT rolls back the transaction',
  { skip },
  async (t) => {
    const { conn } = await dbFixture(t);

    await execSqlScript({
      ...conn,
      sql: 'CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB);',
    });

    await assert.rejects(
      execSqlScript({
        ...conn,
        sql: `BEGIN IMMEDIATE;
INSERT INTO ItemTable VALUES ('ok', '1');
INSERT INTO ItemTable VALUES (oops);
COMMIT;`,
      }),
    );

    const out = await execSql({
      ...conn,
      sql: 'SELECT count(*) FROM ItemTable;',
      readOnly: true,
    });

    assert.equal(out.trim(), '0');
  },
);

test(
  'busy timeout reaches read, mutation and hex-row connections',
  { skip },
  async (t) => {
    const { conn } = await dbFixture(t);

    assert.equal(
      (
        await execSqlScript({
          ...conn,
          busyTimeoutMs: 1234,
          sql: 'PRAGMA busy_timeout;',
        })
      ).trim(),
      '1234',
    );

    assert.equal(
      (
        await execSql({
          ...conn,
          busyTimeoutMs: 0,
          sql: 'PRAGMA busy_timeout;',
        })
      ).trim(),
      '0',
    );

    const { execSqlHexRows, backupDatabase } = await import('../src/sqlite');
    const rows: string[] = [];

    await execSqlHexRows({
      ...conn,
      busyTimeoutMs: 2345,
      cols: 1,
      sql: 'SELECT hex(timeout) FROM pragma_busy_timeout;',
      onRow: ([value]) => {
        rows.push(value.toString());
      },
    });

    assert.deepEqual(rows, ['2345']);

    await assert.rejects(
      backupDatabase({
        ...conn,
        dest: path.join(path.dirname(conn.database), 'copy.db'),
        busyTimeoutMs: -1,
      }),
      /busy timeout/,
    );
  },
);

test(
  'write waits for a brief SQLite lock when configured, and fails immediately at zero',
  { skip },
  async (t) => {
    const { spawn } = await import('node:child_process');
    const { conn } = await dbFixture(t);

    await execSqlScript({ ...conn, sql: 'CREATE TABLE writes (id INTEGER);' });

    const child = spawn(
      conn.executable,
      ['-init', conn.initFile, '-batch', conn.database],
      { stdio: 'pipe', shell: false },
    );

    t.after(() => {
      child.kill();
    });

    const ready = new Promise<void>((resolve, reject) => {
      let settled = false;

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.off('exit', onExit);
        child.off('error', onError);
        fn();
      };

      const timer = setTimeout(() => {
        child.kill();
        finish(() => reject(new Error('sqlite child did not become ready')));
      }, 8_000);

      const onError = (error: Error) => finish(() => reject(error));

      const onExit = (code: number | null) =>
        finish(() =>
          reject(new Error(`sqlite child exited ${code} before READY`)),
        );

      child.once('error', onError);
      child.once('exit', onExit);

      child.stdout.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('READY')) finish(() => resolve());
      });
    });

    child.stdin.write('BEGIN IMMEDIATE;\n.print READY\n');
    await ready;

    await assert.rejects(
      execSqlScript({
        ...conn,
        busyTimeoutMs: 0,
        sql: 'INSERT INTO writes VALUES (1);',
      }),
    );

    const waiting = execSqlScript({
      ...conn,
      busyTimeoutMs: 2000,
      sql: 'INSERT INTO writes VALUES (2);',
    });

    const timer = setTimeout(() => child.stdin.end('COMMIT;\n'), 150);

    try {
      await waiting;
    } finally {
      clearTimeout(timer);
    }

    assert.equal(
      (await execSql({ ...conn, sql: 'SELECT id FROM writes;' })).trim(),
      '2',
    );
  },
);

test(
  'sparse header JSON uses real timestamp columns for chat ordering',
  { skip },
  async (t) => {
    const { conn } = await dbFixture(t);
    const { readComposerHeadersTable } = await import('../src/db-read');

    await execSqlScript({
      ...conn,
      sql: `CREATE TABLE composerHeaders (composerId TEXT, value TEXT, createdAt INTEGER, lastUpdatedAt INTEGER);
INSERT INTO composerHeaders VALUES ('one', '{"composerId":"one","name":"Real name"}', 1000, 2000);`,
    });

    const columns = ['composerId', 'value', 'createdAt', 'lastUpdatedAt'];
    const [header] = await readComposerHeadersTable(conn, columns, true);
    const [raw] = await readComposerHeadersTable(conn, columns);

    assert.equal(raw.createdAt, undefined);
    assert.equal(raw.lastUpdatedAt, undefined);
    assert.equal(header.createdAt, 1000);
    assert.equal(header.lastUpdatedAt, 2000);
    assert.equal(header.name, 'Real name');
  },
);
