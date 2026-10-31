import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SqliteSession } from '../src/sqlite-session';
import { NativeDatabase, nativeSqliteVersion } from '../src/sqlite-native';
import type { SqlRow } from '../src/sqlite-native';

async function fixture(t: { after: (run: () => Promise<void>) => void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cct-native-driver-'));

  const session = await SqliteSession.open({
    database: path.join(root, 'test.sqlite'),
  });

  t.after(async () => {
    await session.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  await session.exec('CREATE TABLE kv(key TEXT PRIMARY KEY,value);');

  return { root, session };
}

for (const [name, bytes, kind] of [
  ['empty text', Buffer.alloc(0), 'text'],
  ['empty blob', Buffer.alloc(0), 'blob'],
  ['NUL text', Buffer.from('a\0b'), 'text'],
  ['Unicode text', Buffer.from('Привет 👋'), 'text'],
  ['arbitrary binary', Buffer.from([0, 255, 128, 13, 10, 39]), 'blob'],
  ['raw TEXT bytes', Buffer.from([255, 0, 128]), 'text'],
] as const) {
  test(`native IPC preserves ${name} and SQLite storage class`, async (t) => {
    const { session } = await fixture(t);

    await session.exec(
      `INSERT INTO kv VALUES (?,${kind === 'text' ? 'CAST(? AS TEXT)' : '?'});`,
      [name, bytes],
    );

    const rows: SqlRow[] = [];

    await session.rows(
      'SELECT typeof(value),CAST(value AS BLOB) FROM kv WHERE key=?;',
      [name],
      (row) => {
        rows.push(row);
      },
    );

    assert.equal(rows[0]![0], kind);
    assert.deepEqual(rows[0]![1], bytes);
  });
}

test('SQL parameters preserve quotes and semicolons without changing the statement', async (t) => {
  const { session } = await fixture(t);
  const text = "'); DROP TABLE kv; --\nSELECT 'value'";

  await session.exec('INSERT INTO kv VALUES (?,?);', ['key', text]);

  assert.equal(
    (await session.exec('SELECT value FROM kv WHERE key=?;', ['key'])).trim(),
    text,
  );

  assert.equal((await session.exec('SELECT count(*) FROM kv;')).trim(), '1');
});

test('fatal script failure rolls back and poisons the connection', async (t) => {
  const { root, session } = await fixture(t);

  await assert.rejects(
    session.exec(
      "BEGIN IMMEDIATE; INSERT INTO kv VALUES('a','value'); INSERT INTO absent VALUES(1); COMMIT;",
    ),
    /absent/,
  );

  await assert.rejects(session.exec('SELECT 1;'));
  await session.close();

  const reader = await SqliteSession.open({
    database: path.join(root, 'test.sqlite'),
    readOnly: true,
  });

  try {
    assert.equal((await reader.exec('SELECT count(*) FROM kv;')).trim(), '0');
  } finally {
    await reader.close();
  }
});

test('standard SQL trigger scripts work without a JavaScript SQL splitter', async (t) => {
  const { session } = await fixture(t);

  await session.exec(
    "CREATE TABLE events(x); CREATE TRIGGER record AFTER INSERT ON kv BEGIN INSERT INTO events VALUES('a;b'); INSERT INTO events VALUES('c'); END;",
  );

  await session.exec('INSERT INTO kv VALUES (?,?);', ['one', 'two']);

  assert.equal(
    (await session.exec('SELECT group_concat(x) FROM events;')).trim(),
    'a;b,c',
  );
});

test('SQL NULL remains distinct from empty text and blob', async (t) => {
  const { session } = await fixture(t);

  await session.exec('INSERT INTO kv VALUES (?,?);', ['null', null]);

  await session.rows('SELECT value,typeof(value) FROM kv;', [], (row) => {
    assert.equal(row[0], null);
    assert.equal(row[1], 'null');
  });
});

test('native main and attached WAL connections use FULL durability', async (t) => {
  const { root, session } = await fixture(t);

  await session.exec('PRAGMA journal_mode=WAL;');

  await session.exec('ATTACH DATABASE ? AS other;', [
    path.join(root, 'other.sqlite'),
  ]);

  assert.equal((await session.exec('PRAGMA main.synchronous;')).trim(), '2');
  assert.equal((await session.exec('PRAGMA other.synchronous;')).trim(), '2');
  assert.equal((await session.exec('PRAGMA main.journal_mode;')).trim(), 'wal');
});

test('mustExist refuses to silently create a missing Cursor database', async (t) => {
  const { root } = await fixture(t);
  const file = path.join(root, 'absent.sqlite');

  await assert.rejects(
    SqliteSession.open({ database: file, mustExist: true }),
    /exist|open/i,
  );

  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
});

test('native read-only connections reject writes', async (t) => {
  const { root } = await fixture(t);

  const reader = await SqliteSession.open({
    database: path.join(root, 'test.sqlite'),
    readOnly: true,
  });

  try {
    await assert.rejects(
      reader.exec("INSERT INTO kv VALUES('a','b');"),
      /readonly/,
    );
  } finally {
    await reader.close();
  }
});

test('busy timeout rejects invalid values before opening a file', () => {
  for (const busyTimeoutMs of [-1, 30001, 1.5, Number.NaN])
    assert.throws(
      () => new NativeDatabase({ database: ':memory:', busyTimeoutMs }),
      /timeout/,
    );
});

test('bundled engine reports the pinned SQLite version', () => {
  assert.equal(nativeSqliteVersion(), '3.53.4');
});

test('64-bit SQLite integers survive typed IPC without Number rounding', async (t) => {
  const { session } = await fixture(t);
  const integer = 9223372036854775807n;

  await session.exec('INSERT INTO kv VALUES (?,?);', ['integer', integer]);

  await session.rows('SELECT value FROM kv;', [], (row) =>
    assert.equal(row[0], integer),
  );
});

test('a recycled worker has no attached databases or open transaction', async (t) => {
  const { root, session } = await fixture(t);

  await session.exec('ATTACH DATABASE ? AS attached;', [
    path.join(root, 'attached.sqlite'),
  ]);

  await session.exec(
    "BEGIN IMMEDIATE; INSERT INTO kv VALUES('uncommitted','value');",
  );

  await session.close();

  const second = await SqliteSession.open({
    database: path.join(root, 'test.sqlite'),
  });

  try {
    assert.equal(
      (await second.exec('SELECT count(*) FROM pragma_database_list;')).trim(),
      '1',
    );

    assert.equal((await second.exec('SELECT count(*) FROM kv;')).trim(), '0');
  } finally {
    await second.close();
  }
});

test('reusing an attachment alias reapplies FULL to the new database', async (t) => {
  const { root, session } = await fixture(t);

  await session.exec('ATTACH DATABASE ? AS other;', [
    path.join(root, 'first.sqlite'),
  ]);

  await session.exec('DETACH DATABASE other;');

  await session.exec('ATTACH DATABASE ? AS other;', [
    path.join(root, 'second.sqlite'),
  ]);

  assert.equal((await session.exec('PRAGMA other.synchronous;')).trim(), '2');
});
