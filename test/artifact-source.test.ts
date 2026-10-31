import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readArtifactSource } from '../src/artifact-source';
import { MAX_RESOURCE_BYTES } from '../src/resource-bytes';
import { TransferError } from '../src/types';

/** Throwaway artifact root deleted after a test. */
async function tempDir(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cct-artifact-'));

  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  return dir;
}

const valid = (name: string) => /^[a-z][a-z0-9.-]+\.data$/.test(name);

test('artifact source returns stable bytes and content hash', async (t) => {
  const root = await tempDir(t);

  await fs.writeFile(path.join(root, 'safe.data'), 'stable');

  const source = await readArtifactSource({
    root,
    filename: 'safe.data',
    isBasename: valid,
    kind: 'Test artifact',
  });

  assert.equal(source?.bytes.toString(), 'stable');
  assert.equal(source?.byteLength, 6);

  assert.equal(
    source?.sha256,
    'f379ccb92b9116442dc65bdc35648a85d3786b34779db7f704a901fa07b00cb6',
  );
});

test('artifact source rejects traversal and symlinks', async (t) => {
  const root = await tempDir(t);
  const outside = path.join(root, '..', `${path.basename(root)}-outside.data`);

  await fs.writeFile(outside, 'outside');
  t.after(() => fs.rm(outside, { force: true }));
  await fs.symlink(outside, path.join(root, 'link.data'));

  await assert.rejects(
    () =>
      readArtifactSource({
        root,
        filename: '../escape.data',
        isBasename: valid,
        kind: 'Test artifact',
      }),
    (error: unknown) =>
      error instanceof TransferError && error.code === 'INVALID_RESOURCE',
  );

  assert.equal(
    await readArtifactSource({
      root,
      filename: 'link.data',
      isBasename: valid,
      kind: 'Test artifact',
    }),
    null,
  );
});

test('artifact source enforces size before reading', async (t) => {
  const root = await tempDir(t);

  await fs.writeFile(
    path.join(root, 'large.data'),
    Buffer.alloc(MAX_RESOURCE_BYTES + 1),
  );

  await assert.rejects(
    () =>
      readArtifactSource({
        root,
        filename: 'large.data',
        isBasename: valid,
        kind: 'Test artifact',
      }),
    /size limit/i,
  );
});

test('artifact source retries one concurrent replacement', async (t) => {
  const root = await tempDir(t);
  const file = path.join(root, 'race.data');
  let calls = 0;

  await fs.writeFile(file, 'first');

  const source = await readArtifactSource({
    root,
    filename: 'race.data',
    isBasename: valid,
    kind: 'Test artifact',
    afterReadAttempt: async () => {
      calls++;

      if (calls === 1) {
        await fs.rename(file, `${file}.old`);
        await fs.writeFile(file, 'second');
      }
    },
  });

  assert.equal(calls, 2);
  assert.equal(source?.bytes.toString(), 'second');
});

test('artifact source fails after a second concurrent change', async (t) => {
  const root = await tempDir(t);
  const file = path.join(root, 'race.data');

  await fs.writeFile(file, 'zero');

  await assert.rejects(
    () =>
      readArtifactSource({
        root,
        filename: 'race.data',
        isBasename: valid,
        kind: 'Test artifact',
        afterReadAttempt: async (attempt) => {
          await fs.rename(file, `${file}.${attempt}`);
          await fs.writeFile(file, String(attempt));
        },
      }),
    /changed while/i,
  );
});
