import { observeTransfer } from '../src/transfer-events';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BundleWriter } from '../src/bundle-writer';
import { openBundle } from '../src/bundle-reader';
import { packZip, extractZip } from '../src/bundle-zip';
import { MAX_MANIFEST_BYTES } from '../src/bundle-limits';

/** Temp directory removed when the test ends. */
async function fixture(t: { after: (run: () => Promise<void>) => void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cct-format-test-'));

  t.after(() => fs.rm(root, { recursive: true, force: true }));

  return root;
}

test('v4 round trip has bounded chat parts and verifies their inventory', async (t) => {
  const root = await fixture(t);
  const file = path.join(root, 'chat.zip');
  const writer = await BundleWriter.open(file);

  await writer.beginChat({ composerId: 'chat', name: 'Fixture' });
  await writer.writeComposer({ composerId: 'chat' }, 'empty');
  await writer.writeBubble('message', { text: 'hello' });
  await writer.endChat();
  await writer.finish();
  const bundle = await openBundle(file);

  try {
    assert.equal(bundle.manifest.formatVersion, 4);
    assert.equal(bundle.manifest.counts.chats, 1);

    const members = await fs.readdir(
      path.join(bundle.root, 'chats', '000001', 'bubbles'),
    );

    assert.deepEqual(members, ['000001.ndjson']);

    const row = JSON.parse(
      await fs.readFile(
        path.join(bundle.root, 'chats', '000001', 'bubbles', members[0]),
        'utf8',
      ),
    );

    assert.equal(row.payload.text, 'hello');
  } finally {
    await bundle.close();
  }
});

test('cancelled packaging keeps the previous destination and removes partial files', async (t) => {
  const root = await fixture(t);
  const destination = path.join(root, 'keep.zip');
  const source = path.join(root, 'source');

  await fs.writeFile(destination, 'previous archive');
  const handle = await fs.open(source, 'w');

  await handle.truncate(32 * 1024 * 1024);
  await handle.close();
  const controller = new AbortController();

  const work = packZip(
    destination,
    [{ diskPath: source, name: 'blob.bin' }],
    controller.signal,
  );

  controller.abort();
  await assert.rejects(() => work, { name: 'AbortError' });
  assert.equal(await fs.readFile(destination, 'utf8'), 'previous archive');
  assert.deepEqual((await fs.readdir(root)).sort(), ['keep.zip', 'source']);
});

test('ZIP duplicate names and oversized manifests are rejected before parsing', async (t) => {
  const root = await fixture(t);
  const source = path.join(root, 'source');

  await fs.writeFile(source, '{}');
  const duplicates = path.join(root, 'duplicates.zip');

  await packZip(duplicates, [
    { diskPath: source, name: 'a.json' },
    { diskPath: source, name: 'A.json' },
  ]);

  const extracted = path.join(root, 'extract');

  await fs.mkdir(extracted);
  await assert.rejects(() => extractZip(duplicates, extracted), /duplicated/);
  await fs.writeFile(source, 'x'.repeat(MAX_MANIFEST_BYTES + 1));
  const oversized = path.join(root, 'oversized.zip');

  await packZip(oversized, [{ diskPath: source, name: 'manifest.json' }]);

  await assert.rejects(
    () => openBundle(oversized),
    /size or available disk budget/,
  );
});

test('archive entry paths cannot escape staging', async (t) => {
  const root = await fixture(t);

  await assert.rejects(
    () =>
      packZip(path.join(root, 'bad.zip'), [
        { diskPath: path.join(root, 'source'), name: '../outside' },
      ]),
    /safe relative path/,
  );

  assert.deepEqual(await fs.readdir(root), []);
});

test('ZIP progress measures input bytes and ends at the real total', async (t) => {
  const root = await fixture(t);
  const source = path.join(root, 'source');

  await fs.writeFile(source, 'a'.repeat(1024 * 1024));
  const ticks: Array<{ processed?: number; total?: number }> = [];

  await observeTransfer(
    {
      phase: (phase, metrics) => {
        if (phase === 'pack' && metrics) ticks.push(metrics);
      },
    },
    () =>
      packZip(path.join(root, 'output.zip'), [
        { diskPath: source, name: 'source.bin' },
      ]),
  );

  assert.equal(ticks[0].processed, 0);
  assert.equal(ticks[0].total, 1024 * 1024);
  assert.equal(ticks.at(-1)?.processed, 1024 * 1024);
  assert.equal(ticks.at(-1)?.total, 1024 * 1024);
});

test('extraction reports one byte total across small files and honours pre-cancellation', async (t) => {
  const root = await fixture(t);
  const source = path.join(root, 'input.bin');

  await fs.writeFile(source, Buffer.alloc(1024, 17));
  const archive = path.join(root, 'files.zip');

  await packZip(
    archive,
    Array.from({ length: 50 }, (_, i) => ({
      diskPath: source,
      name: `blobs/${i}.bin`,
    })),
  );

  const destination = path.join(root, 'extract');

  await fs.mkdir(destination);
  const ticks: import('../src/types').TransferPhaseMetrics[] = [];

  await observeTransfer(
    {
      phase: (phase, metrics) => {
        if (phase === 'extract' && metrics) ticks.push(metrics);
      },
    },
    () => extractZip(archive, destination),
  );

  assert.equal(ticks[0]!.processed, 0);
  assert.equal(ticks.at(-1)!.processed, 51200);

  for (const [i, tick] of ticks.entries()) {
    assert.equal(tick.total, 51200);
    assert.equal(tick.scope, 'archive-extraction');
    if (i) assert.ok(tick.processed! >= ticks[i - 1]!.processed!);
  }

  const cancelled = path.join(root, 'cancelled');

  await fs.mkdir(cancelled);

  await assert.rejects(
    () => extractZip(archive, cancelled, AbortSignal.abort()),
    { name: 'AbortError' },
  );

  assert.deepEqual(await fs.readdir(cancelled), []);
});

test('measured NDJSON consumption reports exact file bytes and no success after invalid input', async (t) => {
  const { readMeasuredNdjson } = await import('../src/progress-reader');
  const root = await fixture(t);
  const file = path.join(root, 'rows.ndjson');
  const content = `${JSON.stringify({ text: 'я'.repeat(50000) })}\r\n{}\n`;

  await fs.writeFile(file, content);
  const ticks: import('../src/types').TransferPhaseMetrics[] = [];

  const ctx = {
    executable: '',
    initFile: '',
    onPhase: (
      _phase: unknown,
      metrics?: import('../src/types').TransferPhaseMetrics,
    ) => {
      if (metrics) ticks.push(metrics);
    },
  };

  let records = 0;

  for await (const row of readMeasuredNdjson(file, 'test', ctx)) {
    assert.equal(typeof row.value, 'object');
    records++;
  }

  assert.equal(records, 2);
  assert.equal(ticks[0]!.processed, 0);
  assert.equal(ticks.at(-1)!.processed, Buffer.byteLength(content));
  assert.equal(ticks.at(-1)!.total, Buffer.byteLength(content));
  await fs.writeFile(file, '{invalid');
  ticks.length = 0;

  await assert.rejects(async () => {
    for await (const row of readMeasuredNdjson(file, 'test', ctx)) {
      assert.equal(typeof row.value, 'object');
      records++;
    }
  });

  assert.ok(ticks.every((tick) => tick.processed !== tick.total));
});
