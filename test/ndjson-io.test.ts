import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BundleWriter } from '../src/bundle-writer';
import { NdjsonPartWriter, readNdjson } from '../src/ndjson-io';
import { assertJsonLimits, parseBoundedJson } from '../src/record-json';
import { MAX_JSON_KEYS, MAX_JSON_RECORD_BYTES } from '../src/bundle-limits';

test('ndjson reader rejects a line that exceeds the record limit', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cct-ndjson-'));
  const file = path.join(dir, 'rows.ndjson');

  try {
    await writeFile(file, `${'x'.repeat(MAX_JSON_RECORD_BYTES + 1)}\n`);

    await assert.rejects(async () => {
      for await (const row of readNdjson(file, 'row')) {
        void row;
      }
    }, /limit is/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ndjson reader keeps a record under the limit', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cct-ndjson-'));
  const file = path.join(dir, 'rows.ndjson');

  try {
    await writeFile(file, '{"ok":1}\n');
    const rows = [];

    for await (const row of readNdjson(file, 'row')) rows.push(row.value);

    assert.deepEqual(rows, [{ ok: 1 }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a mention selection larger than 64 KiB stays one object key', () => {
  const selection = JSON.stringify({
    uri: 'vscode-test-data://results/example',
    range: { positionLineNumber: 1, positionColumn: 1 },
    text: 'x'.repeat(70_000),
  });

  const parsed = parseBoundedJson(
    Buffer.from(
      JSON.stringify({
        context: { mentions: { selections: { [selection]: [] } } },
      }),
    ),
    'bubble',
  ) as {
    context: { mentions: { selections: Record<string, unknown> } };
  };

  const keys = Object.keys(parsed.context.mentions.selections);

  assert.equal(keys.length, 1);
  assert.equal(keys[0], selection);
  assert.deepEqual(parsed.context.mentions.selections[selection], []);
});

test('a long conversation index stays readable and one past the key limit does not', () => {
  const header = {
    bubbleId: 'm',
    type: 1,
    grouping: { textPreview: 'x' },
    serverBubbleId: 's',
    requestId: 'r',
    tokenCount: { input: 1, output: 1 },
  };

  const parsed = parseBoundedJson(
    Buffer.from(
      JSON.stringify({
        _v: 18,
        isNAL: true,
        fullConversationHeadersOnly: Array.from(
          { length: 13_000 },
          () => header,
        ),
      }),
    ),
    'composer',
  ) as { fullConversationHeadersOnly: unknown[] };

  assert.equal(parsed.fullConversationHeadersOnly.length, 13_000);

  const wide: Record<string, number> = {};

  for (let index = 0; index < MAX_JSON_KEYS + 1; index++) wide[`k${index}`] = 1;

  assert.throws(() => assertJsonLimits(wide, 'composer'), /properties/);
});

test('bounded JSON rejects invalid UTF-8 even when replacement has the same byte count', () => {
  const bytes = Buffer.concat([
    Buffer.from('{"x":"'),
    Buffer.from([0xed, 0xa0, 0x80]),
    Buffer.from('"}'),
  ]);

  assert.throws(() => parseBoundedJson(bytes, 'fixture'), /UTF-8/);
});

test('NDJSON preserves a multi-chunk record, CRLF and final line without newline', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cct-ndjson-'));

  try {
    const file = path.join(dir, 'rows.ndjson');
    const value = { text: 'я'.repeat(1000000) };

    await writeFile(file, `${JSON.stringify(value)}\r\n\n{"last":true}`);
    const rows = [];

    for await (const row of readNdjson(file, 'record')) rows.push(row.value);
    assert.deepEqual(rows, [value, { last: true }]);
    const aborted = new AbortController();

    aborted.abort();

    await assert.rejects(
      async () => {
        for await (const row of readNdjson(file, 'record', aborted.signal))
          void row;
      },
      { name: 'AbortError' },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a payload at the property limit survives the bubble envelope', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cct-json-boundary-'));

  try {
    const payload = {
      entries: Array.from({ length: 999_999 }, () => ({ x: 0 })),
    };

    parseBoundedJson(Buffer.from(JSON.stringify(payload)), 'source bubble');

    const writer = new NdjsonPartWriter(dir, undefined, undefined, 'bubble');

    await writer.write({
      bubbleId: '11111111-1111-4111-8111-111111111111',
      payload,
    });

    await writer.finish();

    for (const file of writer.files()) {
      for await (const row of readNdjson(
        file,
        'exported bubble',
        undefined,
        undefined,
        undefined,
        'bubble',
      ))
        assert.ok(row);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a plain object with bubble keys uses the full property budget', () => {
  const value = {
    bubbleId: '11111111-1111-4111-8111-111111111111',
    payload: { entries: Array.from({ length: 999_999 }, () => ({ x: 0 })) },
  };

  assert.throws(
    () => parseBoundedJson(Buffer.from(JSON.stringify(value)), 'plain'),
    /properties/,
  );
});

test('composer writer honors a budget above and below the default', async () => {
  const above = await mkdtemp(path.join(os.tmpdir(), 'cct-composer-above-'));

  const writer = await BundleWriter.open(path.join(above, 'test.zip'), {
    maxJsonProperties: 1_100_000,
  });

  try {
    await writer.beginChat({ composerId: 'root' });

    await writer.writeComposer(
      { entries: Array.from({ length: 1_000_001 }, () => ({ x: 0 })) },
      'absent',
    );
  } finally {
    await writer.abort();
    await rm(above, { recursive: true, force: true });
  }

  const below = await mkdtemp(path.join(os.tmpdir(), 'cct-composer-below-'));

  const tight = await BundleWriter.open(path.join(below, 'test.zip'), {
    maxJsonProperties: 100_000,
  });

  try {
    await tight.beginChat({ composerId: 'root' });

    await assert.rejects(
      () =>
        tight.writeComposer(
          { entries: Array.from({ length: 100_001 }, () => ({ x: 0 })) },
          'absent',
        ),
      /properties/,
    );
  } finally {
    await tight.abort();
    await rm(below, { recursive: true, force: true });
  }
});
