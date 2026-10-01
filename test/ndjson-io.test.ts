import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readNdjson } from '../src/ndjson-io';
import { parseBoundedJson } from '../src/record-json';
import { MAX_JSON_RECORD_BYTES } from '../src/bundle-limits';

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
