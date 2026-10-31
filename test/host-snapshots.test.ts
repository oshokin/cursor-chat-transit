import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  discoverHostSession,
  hostStorageRoot,
  publishHostSnapshot,
  snapshotHostSession,
  validateHostSnapshot,
} from '../src/host-snapshots';
import { SqliteSession } from '../src/sqlite-session';

const id = '11111111-2222-4333-8444-555555555555';
const rootHex = 'ab'.repeat(32);

async function fixture(root: string, sessionId = id): Promise<string> {
  const dir = path.join(hostStorageRoot(root), 'sessions', sessionId);

  await fs.mkdir(dir, { recursive: true });
  const database = path.join(dir, 'session.sqlite');
  const db = await SqliteSession.open({ database });

  try {
    await db.exec(`
PRAGMA user_version=1;
PRAGMA journal_mode=WAL;
CREATE TABLE ItemTable(key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
CREATE TABLE cursorDiskKV(key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);`);

    await db.exec('INSERT INTO ItemTable(key,value) VALUES (?,?);', [
      'agentHost:sessionManifest',
      JSON.stringify({
        manifestVersion: 1,
        sessionId,
        latestRootBlobIdHex: rootHex,
        origin: 'host-native',
        createdAtMs: 1,
        migratedBlobCount: 0,
      }),
    ]);

    await db.exec('INSERT INTO cursorDiskKV(key,value) VALUES (?,?);', [
      `agentKv:blob:${rootHex}`,
      Buffer.from('opaque root'),
    ]);

    await db.exec('INSERT INTO cursorDiskKV(key,value) VALUES (?,?);', [
      'wal-only',
      Buffer.from('visible'),
    ]);
  } finally {
    await db.close();
  }

  await fs.writeFile(
    path.join(dir, 'meta.json'),
    JSON.stringify({
      schemaVersion: 1,
      sessionId,
      origin: 'host-native',
      createdAtMs: 1,
      isArchived: false,
      latestRootBlobIdHex: rootHex,
    }),
  );

  return dir;
}

test('discovers and snapshots a compatible host store through SQLite', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cct-host-'));

  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fixture(root);

  assert.equal(
    await discoverHostSession(root, id),
    path.join(hostStorageRoot(root), 'sessions', id),
  );

  const staging = path.join(root, 'private');

  await fs.mkdir(staging);

  const snapshot = await snapshotHostSession({
    userDataDir: root,
    sessionId: id,
    stagingDir: staging,
  });

  assert.ok(snapshot);
  await validateHostSnapshot(snapshot);

  const db = await SqliteSession.open({
    database: snapshot.database,
    readOnly: true,
  });

  try {
    assert.equal(
      (
        await db.text(
          'SELECT CAST(value AS TEXT) FROM cursorDiskKV WHERE key=?;',
          ['wal-only'],
        )
      ).trim(),
      'visible',
    );
  } finally {
    await db.close();
  }

  assert.equal(
    (await fs.readdir(path.dirname(snapshot.database))).includes('data.sqlite'),
    false,
  );
});

test('validation rejects schema, identity, manifest, root and file aliases', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cct-host-bad-'));

  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dir = await fixture(root);

  const snapshot = {
    sessionId: id,
    database: path.join(dir, 'session.sqlite'),
    meta: path.join(dir, 'meta.json'),
  };

  await validateHostSnapshot(snapshot);

  await fs.writeFile(snapshot.meta, '{}');
  await assert.rejects(validateHostSnapshot(snapshot), /meta\.json/);

  await fs.writeFile(
    snapshot.meta,
    JSON.stringify({
      schemaVersion: 1,
      sessionId: id,
      origin: 'host-native',
      createdAtMs: 1,
      isArchived: false,
      latestRootBlobIdHex: rootHex,
    }),
  );

  await fs.rm(snapshot.meta);
  await fs.symlink('/dev/null', snapshot.meta);
  await assert.rejects(validateHostSnapshot(snapshot), /regular file/);
  await fs.rm(snapshot.meta);

  await fs.writeFile(
    snapshot.meta,
    JSON.stringify({
      schemaVersion: 1,
      sessionId: id,
      origin: 'host-native',
      createdAtMs: 1,
      isArchived: false,
      latestRootBlobIdHex: rootHex,
    }),
  );

  const db = await SqliteSession.open({ database: snapshot.database });

  try {
    await db.exec('DELETE FROM cursorDiskKV WHERE key=?;', [
      `agentKv:blob:${rootHex}`,
    ]);
  } finally {
    await db.close();
  }

  await assert.rejects(validateHostSnapshot(snapshot), /root is missing/);

  await assert.rejects(
    validateHostSnapshot({ ...snapshot, sessionId: 'other' }),
    /does not match/,
  );
});

test('validation enforces the installed Cursor manifest v1 and v2 contracts', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cct-host-manifest-'));

  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dir = await fixture(root);

  const snapshot = {
    sessionId: id,
    database: path.join(dir, 'session.sqlite'),
    meta: path.join(dir, 'meta.json'),
  };

  const db = await SqliteSession.open({ database: snapshot.database });

  try {
    const writeManifest = async (manifest: Record<string, unknown>) =>
      db.exec('UPDATE ItemTable SET value=? WHERE key=?;', [
        JSON.stringify(manifest),
        'agentHost:sessionManifest',
      ]);

    const base = {
      sessionId: id,
      latestRootBlobIdHex: rootHex,
      origin: 'host-native',
      createdAtMs: 1,
      migratedBlobCount: 0,
    };

    await writeManifest({ ...base, manifestVersion: 1 });
    await validateHostSnapshot(snapshot);

    await writeManifest({
      ...base,
      manifestVersion: 2,
      listHeads: { turns: 0, prompt: 0, archives: 0 },
      latestStructureIdHex: 'cd'.repeat(32),
      conversionEpoch: 0,
    });

    await validateHostSnapshot(snapshot);

    for (const invalid of [
      { ...base, manifestVersion: 1, migratedBlobCount: undefined },
      { ...base, manifestVersion: 1, origin: 'migrated-from-renderer-cas' },
      { ...base, manifestVersion: 2 },
      {
        ...base,
        manifestVersion: 2,
        listHeads: { turns: -1, prompt: 0, archives: 0 },
      },
      {
        ...base,
        manifestVersion: 2,
        listHeads: { turns: 0, prompt: 0, archives: 0 },
        latestStructureIdHex: 'not-a-hash',
      },
    ]) {
      await writeManifest(invalid);

      await assert.rejects(
        validateHostSnapshot(snapshot),
        /manifest is invalid/,
      );
    }
  } finally {
    await db.close();
  }
});

test('publishes privately without overwrite and refuses renderer collisions', async (t) => {
  const source = await fs.mkdtemp(path.join(os.tmpdir(), 'cct-host-source-'));
  const target = await fs.mkdtemp(path.join(os.tmpdir(), 'cct-host-target-'));

  t.after(() =>
    Promise.all([
      fs.rm(source, { recursive: true, force: true }),
      fs.rm(target, { recursive: true, force: true }),
    ]),
  );

  const dir = await fixture(source);

  const snapshot = {
    sessionId: id,
    database: path.join(dir, 'session.sqlite'),
    meta: path.join(dir, 'meta.json'),
  };

  await assert.rejects(
    publishHostSnapshot({
      userDataDir: target,
      snapshot,
      rendererCollision: true,
    }),
    /renderer id collision/,
  );

  await publishHostSnapshot({
    userDataDir: target,
    snapshot,
    rendererCollision: false,
  });

  const published = path.join(hostStorageRoot(target), 'sessions', id);

  await validateHostSnapshot({
    sessionId: id,
    database: path.join(published, 'session.sqlite'),
    meta: path.join(published, 'meta.json'),
  });

  assert.deepEqual((await fs.readdir(path.dirname(published))).sort(), [id]);

  await assert.rejects(
    publishHostSnapshot({
      userDataDir: target,
      snapshot,
      rendererCollision: false,
    }),
    /host id collision/,
  );
});
