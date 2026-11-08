import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { SqliteSession } from '../src/sqlite-session';
import {
  prepareNativeIntent,
  recoverNativeIntent,
} from '../src/import-native-recovery';
import { hostStorageRoot } from '../src/host-snapshots';
import { JournalStore } from '../src/journal-db';

test('native recovery publishes retained bytes and verifies a rename-before-ledger crash', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cct-native-recover-'));

  const sessionId = 'synthetic-session';
  const database = path.join(root, 'source.sqlite');
  const meta = path.join(root, 'source.json');
  const hash = createHash('sha256').update(Buffer.alloc(0)).digest('hex');
  const db = await SqliteSession.open({ database });

  await db.exec(
    'PRAGMA user_version=1; CREATE TABLE ItemTable(key TEXT PRIMARY KEY,value BLOB); CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY,value BLOB);',
  );

  await db.exec('INSERT INTO ItemTable VALUES (?,?);', [
    'agentHost:sessionManifest',
    JSON.stringify({
      manifestVersion: 1,
      sessionId,
      latestRootBlobIdHex: hash,
      origin: 'host-native',
      createdAtMs: 1,
      migratedBlobCount: 0,
    }),
  ]);

  await db.exec('INSERT INTO cursorDiskKV VALUES (?,?);', [
    `agentKv:blob:${hash}`,
    Buffer.alloc(0),
  ]);

  await db.close();

  await fs.writeFile(
    meta,
    JSON.stringify({
      schemaVersion: 1,
      sessionId,
      origin: 'host-native',
      createdAtMs: 1,
      isArchived: false,
      latestRootBlobIdHex: hash,
    }),
  );

  const journal = await JournalStore.open({
    journalDir: root,
    targetKey: 'synthetic',
  });

  t.after(async () => {
    await journal.close();

    await fs.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  });

  await journal.beginPending({
    operationId: 'synthetic-operation',
    phase: 'prepared',
  });

  const effect = await prepareNativeIntent(journal, 'synthetic-operation', {
    sessionId,
    database,
    meta,
  });

  await fs.unlink(database);
  await fs.unlink(meta);
  await recoverNativeIntent(journal, effect, root);
  // Simulate the durable native rename preceding the ledger acknowledgement.
  await journal.setEffectState(effect.operationId, effect.effectId, 'prepared');
  await recoverNativeIntent(journal, effect, root);
  const effects: string[] = [];

  await journal.forEachEffect(effect.operationId, (row) => {
    effects.push(row.state);
  });

  assert.deepEqual(effects, ['verified']);
  const destination = path.join(hostStorageRoot(root), 'sessions', sessionId);

  await fs.writeFile(
    path.join(destination, 'session.sqlite-wal'),
    'foreign WAL',
  );

  await assert.rejects(recoverNativeIntent(journal, effect, root), /sidecar/);
});

test('native intent survives archive removal and refuses foreign bytes', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cct-native-intent-'));

  const source = path.join(root, 'source');

  await fs.mkdir(source);

  const snapshot = {
    sessionId: 'synthetic-session',
    database: path.join(source, 'session.sqlite'),
    meta: path.join(source, 'meta.json'),
  };

  await fs.writeFile(snapshot.database, 'synthetic database');
  await fs.writeFile(snapshot.meta, '{}');

  const journal = await JournalStore.open({
    journalDir: root,
    targetKey: 'synthetic',
  });

  t.after(async () => {
    await journal.close();

    await fs.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  });

  await journal.beginPending({
    operationId: 'synthetic-operation',
    phase: 'prepared',
  });

  const effect = await prepareNativeIntent(
    journal,
    'synthetic-operation',
    snapshot,
  );

  await fs.rm(source, { recursive: true });

  const staged = path.join(
    root,
    'native-pending',
    'synthetic-operation',
    snapshot.sessionId,
  );

  assert.equal(
    await fs.readFile(path.join(staged, 'session.sqlite'), 'utf8'),
    'synthetic database',
  );

  const destination = path.join(
    hostStorageRoot(root),
    'sessions',
    snapshot.sessionId,
  );

  await fs.mkdir(destination, { recursive: true });
  await fs.writeFile(path.join(destination, 'session.sqlite'), 'foreign');
  await fs.writeFile(path.join(destination, 'meta.json'), '{}');

  await assert.rejects(
    recoverNativeIntent(journal, effect, root),
    /hash mismatch/,
  );

  assert.equal(
    await fs.readFile(path.join(destination, 'session.sqlite'), 'utf8'),
    'foreign',
  );

  await assert.rejects(
    journal.planEffect({
      ...effect,
      detail: JSON.stringify({ version: 1, metaHash: '0'.repeat(64) }),
    }),
    /reused/,
  );
});

test('native recovery rejects missing metadata proof and traversal', async () => {
  const effect = {
    operationId: 'synthetic',
    effectId: 'session:test',
    kind: 'session' as const,
    target: '../foreign',
    desiredHash: '0'.repeat(64),
    state: 'prepared' as const,
    updatedAt: '',
  };

  await assert.rejects(
    recoverNativeIntent({} as JournalStore, effect, '/unused'),
    /identity/,
  );

  await assert.rejects(
    recoverNativeIntent(
      {} as JournalStore,
      { ...effect, target: 'safe' },
      '/unused',
    ),
    /metadata intent/,
  );
});
