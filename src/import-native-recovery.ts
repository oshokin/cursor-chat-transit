import { copyFile, lstat, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { hashFile } from './hash-file';
import {
  hostStorageRoot,
  publishHostSnapshot,
  validateHostSnapshot,
  type HostSnapshot,
} from './host-snapshots';
import type { JournalEffect, JournalStore } from './journal-db';

/** Retain exact native bytes independently of the extracted archive. */
export async function prepareNativeIntent(
  journal: JournalStore,
  operationId: string,
  snapshot: HostSnapshot,
): Promise<JournalEffect> {
  const staging = path.join(
    path.dirname(journal.filePath),
    'native-pending',
    operationId,
    snapshot.sessionId,
  );

  await mkdir(staging, { recursive: true, mode: 0o700 });
  const hashes: string[] = [];

  for (const [source, name] of [
    [snapshot.database, 'session.sqlite'],
    [snapshot.meta, 'meta.json'],
  ]) {
    const destination = path.join(staging, name);

    await copyFile(source, destination);
    const file = await open(destination, 'r');

    try {
      await file.sync();
    } finally {
      await file.close();
    }

    hashes.push((await hashFile(destination)).sha256);
  }

  const directory = await open(staging, 'r');

  try {
    await directory.sync();
  } finally {
    await directory.close();
  }

  // Persist newly created parent entries as well as the leaf files.
  for (const parent of [
    path.dirname(staging),
    path.dirname(path.dirname(staging)),
    path.dirname(journal.filePath),
  ]) {
    const dir = await open(parent, 'r');

    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  }

  const effect = {
    operationId,
    effectId: `session:${snapshot.sessionId}`,
    kind: 'session' as const,
    target: snapshot.sessionId,
    desiredHash: hashes[0],
    state: 'prepared' as const,
    detail: JSON.stringify({ version: 1, metaHash: hashes[1] }),
    updatedAt: new Date().toISOString(),
  };

  await journal.planEffect(effect);
  await journal.setEffectState(operationId, effect.effectId, 'prepared');

  return effect;
}

/** Verify an existing native destination or publish only into an absent one. */
export async function recoverNativeIntent(
  journal: JournalStore,
  effect: JournalEffect,
  userDataDir: string,
): Promise<void> {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(effect.target) ||
    effect.target.includes('..') ||
    !/^[A-Za-z0-9-]+$/.test(effect.operationId)
  )
    throw new Error('Invalid native recovery identity.');

  const detail = JSON.parse(effect.detail || '{}') as {
    version?: number;
    metaHash?: string;
  };

  if (detail.version !== 1 || !/^[a-f0-9]{64}$/.test(detail.metaHash || ''))
    throw new Error('Native recovery requires verifiable metadata intent.');

  const destination = path.join(
    hostStorageRoot(userDataDir),
    'sessions',
    effect.target,
  );

  let present = false;

  try {
    const stat = await lstat(destination);

    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('Native destination is not a regular directory.');
    present = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const root = present
    ? destination
    : path.join(
        path.dirname(journal.filePath),
        'native-pending',
        effect.operationId,
        effect.target,
      );

  const snapshot = {
    sessionId: effect.target,
    database: path.join(root, 'session.sqlite'),
    meta: path.join(root, 'meta.json'),
  };

  for (const [file, expected] of [
    [snapshot.database, effect.desiredHash],
    [snapshot.meta, detail.metaHash!],
  ]) {
    const stat = await lstat(file);

    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      (await hashFile(file)).sha256 !== expected
    )
      throw new Error(
        'Native recovery hash mismatch; destination was not modified.',
      );
  }

  // A WAL may contain foreign changes not represented by the main-file hash.
  if (present)
    for (const suffix of ['-wal', '-journal']) {
      try {
        await lstat(snapshot.database + suffix);

        throw new Error('Native recovery found an active database sidecar.');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }

  await validateHostSnapshot(snapshot);
  if (!present)
    await publishHostSnapshot({
      userDataDir,
      snapshot,
      rendererCollision: false,
    });

  await journal.setEffectState(
    effect.operationId,
    effect.effectId,
    'verified',
    effect.desiredHash,
  );
}
