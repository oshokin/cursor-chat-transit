import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
