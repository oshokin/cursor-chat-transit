import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readJsonFile } from '../src/format';

test('old JSON exports must be re-exported, not imported', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cct-old-json-'));

  t.after(() => fs.rm(root, { recursive: true, force: true }));

  for (const formatVersion of [2, 3, 4, 5]) {
    const file = path.join(root, `${formatVersion}.json`);

    await fs.writeFile(
      file,
      JSON.stringify({ formatVersion, allComposers: [], composers: {} }),
    );

    await assert.rejects(
      () => readJsonFile(file),
      /Older JSON exports are not imported/,
    );
  }
});
