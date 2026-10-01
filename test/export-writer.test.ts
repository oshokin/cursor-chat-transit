import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

describe('export writer', { concurrency: false }, () => {
  test('FileHandle write failure is handled without crashing the host', async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cct-export-writer-'));

    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const dest = path.join(dir, 'failure.json');

    const child = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '-e',
        `
import fs from 'node:fs';
import { ExportFileWriter } from ${JSON.stringify(path.resolve(__dirname, '../src/format.ts'))};
const orig = fs.promises.open.bind(fs.promises);
fs.promises.open = (async (...args: Parameters<typeof orig>) => {
  const file = await orig(...args);
  file.write = (async () => {
    throw Object.assign(new Error('synthetic ENOSPC'), { code: 'ENOSPC' });
  }) as typeof file.write;
  return file;
}) as typeof orig;
let writer;
try {
  writer = await ExportFileWriter.open(process.argv[1]);
  await writer.writePreamble({ formatVersion: 2, source: {}, allComposers: [] });
  await writer.finish({ complete: true, incomplete: [], selected: 0, exported: 0 });
} catch {
  if (writer) await writer.abort();
}
`,
        dest,
      ],
      { encoding: 'utf8' },
    );

    assert.equal(child.status, 0, child.stderr);
  });

  test('ENOSPC leaves the previous export intact and removes the partial file', async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cct-export-keep-'));

    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const dest = path.join(dir, 'kept.json');
    const oldBytes = Buffer.from('{"previous":"valid export"}');

    await fs.writeFile(dest, oldBytes);
    const { ExportFileWriter } = await import('../src/format');
    const orig = nodeFs.promises.open.bind(nodeFs.promises);

    nodeFs.promises.open = (async (...args: Parameters<typeof orig>) => {
      const file = await orig(...args);

      file.write = (async () => {
        throw Object.assign(new Error('synthetic ENOSPC'), { code: 'ENOSPC' });
      }) as typeof file.write;

      return file;
    }) as typeof orig;

    let writer: Awaited<ReturnType<typeof ExportFileWriter.open>> | undefined;

    try {
      writer = await ExportFileWriter.open(dest);

      await assert.rejects(
        () =>
          writer!.writePreamble({
            formatVersion: 3,
            source: {},
            allComposers: [],
          }),
        (error: unknown) =>
          error instanceof Error &&
          (error as NodeJS.ErrnoException).code === 'ENOSPC',
      );
    } finally {
      if (writer) await writer.abort();
      nodeFs.promises.open = orig;
    }

    assert.deepEqual(await fs.readFile(dest), oldBytes);

    assert.equal(
      (await fs.readdir(dir)).some((name) => name.endsWith('.partial')),
      false,
    );
  });

  test('abort before finish does not create a new destination file', async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cct-export-abort-'));

    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const dest = path.join(dir, 'fresh.json');
    const { ExportFileWriter } = await import('../src/format');
    const writer = await ExportFileWriter.open(dest);

    await writer.writePreamble({
      formatVersion: 3,
      source: {},
      allComposers: [],
    });

    await writer.abort();
    await assert.rejects(() => fs.access(dest));

    assert.equal(
      (await fs.readdir(dir)).some((name) => name.endsWith('.partial')),
      false,
    );
  });
});
