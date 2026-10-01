import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  collectAttachmentVariants,
  resolveAttachmentPath,
  rewriteImageReferences,
} from '../src/attachments';
import type { WorkspaceEntry } from '../src/types';

/** Image uuid stored on the bubble. */
const ID = 'bb3aae5d-16d8-4a37-993a-cc2fd2e2aa7b';
/** First Cursor variant suffix. */
const VARIANT_A = '2ea3d901-6f02-4fa8-84ea-bfdfcc8f8b70';
/** Second Cursor variant suffix. */
const VARIANT_B = '230d1375-9223-4c76-a987-c86655c1afc8';

/** Workspace whose images directory is `dir/images`. */
function workspace(dir: string): WorkspaceEntry {
  return {
    storageRoot: dir,
    storageId: 'ws',
    key: 'ws',
    mtime: 0,
    workspaceDbPath: path.join(dir, 'state.vscdb'),
    globalDbPath: path.join(dir, 'global.vscdb'),
  };
}

test('identical uuid-variant copies resolve to one image', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cct-images-'));

  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const images = path.join(dir, 'images');

  await fs.mkdir(images);
  const bytes = Buffer.from('same-png');

  await fs.writeFile(path.join(images, `${ID}-${VARIANT_A}.png`), bytes);
  await fs.writeFile(path.join(images, `${ID}-${VARIANT_B}.png`), bytes);

  const found = await resolveAttachmentPath(workspace(dir), ID);

  assert.ok(found);
  assert.equal(found.extension, 'png');
  assert.deepEqual(await fs.readFile(found.filePath), bytes);
});

test('image-uuid.png is accepted when the exact name is absent', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cct-images-'));

  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const images = path.join(dir, 'images');

  await fs.mkdir(images);
  await fs.writeFile(path.join(images, `image-${ID}.png`), Buffer.from('png'));

  const found = await resolveAttachmentPath(workspace(dir), ID);

  assert.equal(found?.extension, 'png');
  assert.equal(path.basename(found?.filePath || ''), `image-${ID}.png`);
});

test('different bytes stay two files and paths are rewritten per basename', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cct-images-'));

  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const images = path.join(dir, 'images');

  await fs.mkdir(images);
  await fs.writeFile(path.join(images, `${ID}.png`), Buffer.from('one'));

  await fs.writeFile(
    path.join(images, `${ID}-${VARIANT_A}.png`),
    Buffer.from('two'),
  );

  const found = await collectAttachmentVariants(workspace(dir), ID, [
    `${ID}.png`,
    `${ID}-${VARIANT_A}.png`,
  ]);

  assert.equal(found.missing, false);
  assert.equal(found.resources.length, 2);

  assert.deepEqual(
    found.resources.map((row) => row.filename || `${ID}.png`).sort(),
    [`${ID}-${VARIANT_A}.png`, `${ID}.png`],
  );

  const destA = path.join(dir, 'target', `${ID}.png`);
  const destB = path.join(dir, 'target', `${ID}-${VARIANT_A}.png`);

  const rewritten = rewriteImageReferences(
    {
      selectedImages: [
        { path: path.join(images, `${ID}.png`) },
        { path: path.join(images, `${ID}-${VARIANT_A}.png`) },
      ],
      text: path.join(images, `${ID}.png`),
    },
    new Map([
      [`${ID}.png`, destA],
      [`${ID}-${VARIANT_A}.png`, destB],
    ]),
  ) as {
    selectedImages: Array<{ path: string }>;
    text: string;
  };

  assert.equal(rewritten.selectedImages[0].path, destA);
  assert.equal(rewritten.selectedImages[1].path, destB);
  assert.equal(rewritten.text, path.join(images, `${ID}.png`));
});
