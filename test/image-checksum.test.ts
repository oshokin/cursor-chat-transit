import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import nodeFs from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pendingResourceMatches } from '../src/import-reconcile';
import type { WorkspaceEntry } from '../src/types';

const image = '11111111-1111-4111-8111-111111111111.png';

test('an image checksum matches, misses, and does not treat cancel as a mismatch', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cct-image-hash-'));

  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const images = path.join(dir, 'images');

  await fs.mkdir(images);
  const file = path.join(images, image);
  const bytes = Buffer.from('image-bytes');

  await fs.writeFile(file, bytes);

  const workspace = {
    storageRoot: dir,
    storageId: 'storage',
    workspaceDbPath: path.join(dir, 'state.vscdb'),
    globalDbPath: path.join(dir, 'global.vscdb'),
    mtime: 0,
    key: 'storage',
  } as WorkspaceEntry;

  const sha256 = createHash('sha256').update(bytes).digest('hex');

  assert.equal(
    await pendingResourceMatches(
      { kind: 'image', id: image, sha256 },
      {
        workspace,
        connGl: {} as never,
        plansDir: dir,
        canvasesDir: null,
      },
    ),
    true,
  );

  assert.equal(
    await pendingResourceMatches(
      { kind: 'image', id: image, sha256: '0'.repeat(64) },
      {
        workspace,
        connGl: {} as never,
        plansDir: dir,
        canvasesDir: null,
      },
    ),
    false,
  );

  await fs.rm(file);

  assert.equal(
    await pendingResourceMatches(
      { kind: 'image', id: image, sha256 },
      {
        workspace,
        connGl: {} as never,
        plansDir: dir,
        canvasesDir: null,
      },
    ),
    false,
  );

  await fs.writeFile(file, bytes);

  await assert.rejects(() =>
    pendingResourceMatches(
      { kind: 'image', id: image, sha256 },
      {
        workspace,
        connGl: {} as never,
        plansDir: dir,
        canvasesDir: null,
        signal: AbortSignal.abort(),
      },
    ),
  );
});

const bare = '11111111-1111-4111-8111-111111111111';

test('a bare image id matches, and an unreadable images directory is not absence', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cct-image-uuid-'));

  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const images = path.join(dir, 'images');

  await fs.mkdir(images);
  const bytes = Buffer.from('uuid-image');

  await fs.writeFile(path.join(images, `${bare}.png`), bytes);

  const workspace = {
    storageRoot: dir,
    storageId: 'storage',
    workspaceDbPath: path.join(dir, 'state.vscdb'),
    globalDbPath: path.join(dir, 'global.vscdb'),
    mtime: 0,
    key: 'storage',
  } as WorkspaceEntry;

  const sha256 = createHash('sha256').update(bytes).digest('hex');

  const opts = {
    workspace,
    connGl: {} as never,
    plansDir: dir,
    canvasesDir: null,
  };

  assert.equal(
    await pendingResourceMatches({ kind: 'image', id: bare, sha256 }, opts),
    true,
  );

  assert.equal(
    await pendingResourceMatches(
      { kind: 'image', id: bare, sha256: '0'.repeat(64) },
      opts,
    ),
    false,
  );

  await fs.rm(images, { recursive: true });

  assert.equal(
    await pendingResourceMatches({ kind: 'image', id: bare, sha256 }, opts),
    false,
  );

  await fs.mkdir(images);

  const denied = Object.assign(new Error('EACCES'), { code: 'EACCES' });
  const originalRead = nodeFs.promises.readdir;

  nodeFs.promises.readdir = (async () => {
    throw denied;
  }) as typeof nodeFs.promises.readdir;

  try {
    await assert.rejects(
      () => pendingResourceMatches({ kind: 'image', id: bare, sha256 }, opts),
      (error: NodeJS.ErrnoException) => error.code === 'EACCES',
    );
  } finally {
    nodeFs.promises.readdir = originalRead;
  }

  const originalStat = nodeFs.promises.lstat;

  nodeFs.promises.lstat = (async () => {
    throw denied;
  }) as typeof nodeFs.promises.lstat;

  try {
    await assert.rejects(
      () => pendingResourceMatches({ kind: 'image', id: bare, sha256 }, opts),
      (error: NodeJS.ErrnoException) => error.code === 'EACCES',
    );
  } finally {
    nodeFs.promises.lstat = originalStat;
  }

  await assert.rejects(() =>
    pendingResourceMatches(
      { kind: 'image', id: bare, sha256 },
      { ...opts, signal: AbortSignal.abort() },
    ),
  );
});

test('abort during an image read is not reported as a mismatch', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cct-image-abort-'));

  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const images = path.join(dir, 'images');

  await fs.mkdir(images);
  const file = path.join(images, `${bare}.png`);

  await fs.writeFile(file, Buffer.alloc(64 * 1024, 7));

  const workspace = {
    storageRoot: dir,
    storageId: 'storage',
    workspaceDbPath: path.join(dir, 'state.vscdb'),
    globalDbPath: path.join(dir, 'global.vscdb'),
    mtime: 0,
    key: 'storage',
  } as WorkspaceEntry;

  const controller = new AbortController();
  const original = nodeFs.createReadStream;

  nodeFs.createReadStream = ((
    filePath: string,
    options?: { signal?: AbortSignal },
  ) => {
    const stream = original.call(nodeFs, filePath, options);

    stream.once('data', () => controller.abort());

    return stream;
  }) as typeof nodeFs.createReadStream;

  try {
    await assert.rejects(() =>
      pendingResourceMatches(
        { kind: 'image', id: `${bare}.png`, sha256: '0'.repeat(64) },
        {
          workspace,
          connGl: {} as never,
          plansDir: dir,
          canvasesDir: null,
          signal: controller.signal,
        },
      ),
    );
  } finally {
    nodeFs.createReadStream = original;
  }

  const denied = Object.assign(new Error('EACCES'), { code: 'EACCES' });

  nodeFs.createReadStream = (() => {
    throw denied;
  }) as typeof nodeFs.createReadStream;

  try {
    await assert.rejects(
      () =>
        pendingResourceMatches(
          { kind: 'image', id: `${bare}.png`, sha256: '0'.repeat(64) },
          {
            workspace,
            connGl: {} as never,
            plansDir: dir,
            canvasesDir: null,
          },
        ),
      (error: NodeJS.ErrnoException) => error.code === 'EACCES',
    );
  } finally {
    nodeFs.createReadStream = original;
  }
});
