import { observeTransfer } from '../src/transfer-events';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BundleWriter } from '../src/bundle-writer';
import { openBundle } from '../src/bundle-reader';
import { packZip, extractZip, visitZip } from '../src/bundle-zip';
import { MAX_MANIFEST_BYTES } from '../src/bundle-limits';
import { visitBundleIndex } from '../src/bundle-index';
import { createHash } from 'node:crypto';

/** Temp directory removed when the test ends. */
async function fixture(t: { after: (run: () => Promise<void>) => void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cct-format-test-'));

  t.after(() => fs.rm(root, { recursive: true, force: true }));

  return root;
}

test('v5 round trip has an immutable index and bounded chat parts', async (t) => {
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
    assert.equal(bundle.manifest.formatVersion, 5);
    assert.equal(bundle.manifest.counts.chats, 1);
    assert.equal(bundle.manifest.index?.path, 'index.sqlite');

    const catalog: string[] = [];

    await visitBundleIndex(path.join(bundle.root, 'index.sqlite'), {
      inventory: () => undefined,
      catalog: (row) => {
        catalog.push(row.sourceComposerId);
      },
    });

    assert.deepEqual(catalog, ['chat']);

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

test('v5 records bounded aggregate provenance for a combined workspace export', async (t) => {
  const root = await fixture(t);
  const file = path.join(root, 'combined.zip');

  const writer = await BundleWriter.open(file, {
    source: { schema: 'multi-workspace', workspaceCount: 2 },
  });

  await writer.beginChat({ composerId: 'combined-chat', name: 'Fixture' });
  await writer.writeComposer({ composerId: 'combined-chat' }, 'empty');
  await writer.endChat();
  await writer.finish();

  const bundle = await openBundle(file);

  try {
    assert.equal(bundle.manifest.formatVersion, 5);

    assert.deepEqual(bundle.manifest.source, {
      schema: 'multi-workspace',
      workspaceCount: 2,
    });

    assert.equal(JSON.stringify(bundle.manifest.source).includes(root), false);
  } finally {
    await bundle.close();
  }
});

test('ZIP APIs accept async sources and await sequential visitors', async (t) => {
  const root = await fixture(t);
  const source = path.join(root, 'source');
  const archive = path.join(root, 'async.zip');

  await fs.writeFile(source, 'payload');

  async function* entries() {
    yield { diskPath: source, name: 'one.bin' };
    yield { diskPath: source, name: 'two.bin' };
  }

  await packZip(archive, entries());
  const destination = path.join(root, 'visitor');

  await fs.mkdir(destination);
  const visited: string[] = [];
  let active = false;

  await visitZip(archive, destination, async (entry) => {
    assert.equal(active, false);
    active = true;
    await new Promise((resolve) => setTimeout(resolve, 1));
    visited.push(entry.name);
    active = false;
  });

  assert.deepEqual(visited, ['one.bin', 'two.bin']);
});

test('v5 rejects unknown required capabilities', async (t) => {
  const root = await fixture(t);
  const original = path.join(root, 'original.zip');
  const writer = await BundleWriter.open(original);

  await writer.finish();
  const extracted = path.join(root, 'extracted');

  await fs.mkdir(extracted);
  const entries = await extractZip(original, extracted);
  const manifestPath = path.join(extracted, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));

  manifest.capabilities.required.push('future-required-v99');
  await fs.writeFile(manifestPath, JSON.stringify(manifest));

  const changed = path.join(root, 'changed.zip');

  await packZip(
    changed,
    entries.map((entry) => ({
      diskPath: entry.name === 'manifest.json' ? manifestPath : entry.filePath,
      name: entry.name,
    })),
  );

  await assert.rejects(
    () => openBundle(changed),
    /Unsupported required bundle capability/,
  );
});

test('reader retains v4 inventory compatibility', async (t) => {
  const root = await fixture(t);
  const payload = path.join(root, 'payload');
  const inventory = path.join(root, 'inventory.ndjson');
  const manifest = path.join(root, 'manifest.json');
  const body = Buffer.from('legacy');
  const digest = createHash('sha256').update(body).digest('hex');

  await fs.writeFile(payload, body);

  const inventoryBody = Buffer.from(
    `${JSON.stringify({
      path: 'payload.bin',
      bytes: body.length,
      sha256: digest,
      kind: 'blob',
    })}\n`,
  );

  await fs.writeFile(inventory, inventoryBody);

  await fs.writeFile(
    manifest,
    JSON.stringify({
      format: 'cursor-chat-transit',
      formatVersion: 4,
      inventory: {
        path: 'inventory.ndjson',
        bytes: inventoryBody.length,
        sha256: createHash('sha256').update(inventoryBody).digest('hex'),
      },
      counts: { chats: 0, files: 1, contentBytes: body.length },
    }),
  );

  const archive = path.join(root, 'v4.zip');

  await packZip(archive, [
    { diskPath: manifest, name: 'manifest.json' },
    { diskPath: inventory, name: 'inventory.ndjson' },
    { diskPath: payload, name: 'payload.bin' },
  ]);

  const bundle = await openBundle(archive);

  assert.equal(bundle.manifest.formatVersion, 4);
  await bundle.close();
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
  assert.equal(ticks[0].total, undefined);
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
