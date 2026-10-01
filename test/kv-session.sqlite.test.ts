import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SqliteSession } from '../src/sqlite-session';
import { readSessionKv } from '../src/kv-session';
import { ensureInitFile, findSqliteExecutable, execSql } from '../src/sqlite';

const executable = findSqliteExecutable(process.env.SQLITE3_PATH)!;

test(
  'bounded KV reader preserves multi-chunk blobs, text with NUL and missing/empty values',
  { skip: !executable },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cct-kv-session-'));

    t.after(() => fs.rm(root, { recursive: true, force: true }));

    const options = {
      executable,
      database: path.join(root, 'kv.sqlite'),
      initFile: await ensureInitFile(root),
    };

    await execSql({
      ...options,
      readOnly: false,
      sql: `CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY, value);
    INSERT INTO cursorDiskKV VALUES ('large', zeroblob(3145735)), ('text', CAST(X'610062' AS TEXT)), ('empty', X'');`,
    });

    const session = await SqliteSession.open({ ...options, readOnly: true });

    t.after(() => session.close());
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
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cct-kv-large-'));

    t.after(() => fs.rm(root, { recursive: true, force: true }));

    const options = {
      executable,
      database: path.join(root, 'kv.sqlite'),
      initFile: await ensureInitFile(root),
    };

    await execSql({
      ...options,
      readOnly: false,
      sql: "CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY, value); INSERT INTO cursorDiskKV VALUES ('too-large', zeroblob(33554433));",
    });

    const session = await SqliteSession.open({ ...options, readOnly: true });

    t.after(() => session.close());

    await assert.rejects(
      () => readSessionKv(session, 'too-large'),
      /exceeds 33554432 bytes/,
    );
  },
);
