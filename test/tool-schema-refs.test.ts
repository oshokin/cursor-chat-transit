import test from 'node:test';
import assert from 'node:assert/strict';
import schemas from '../src/cursor-tool-schemas.json';
import { toolSchemaRefs } from '../src/tool-schema-refs';

function varint(value: number): Buffer {
  const bytes: number[] = [];

  do {
    const byte = value & 127;

    value >>>= 7;
    bytes.push(byte | (value ? 128 : 0));
  } while (value);

  return Buffer.from(bytes);
}

function field(no: number, bytes: Buffer = Buffer.alloc(0)): Buffer {
  return Buffer.concat([varint(no * 8 + 2), varint(bytes.length), bytes]);
}

test('all installed ToolCall variants validate positively and reject malformed containers', () => {
  let variants = 0;

  for (const spec of schemas['agent.v1.ToolCall']) {
    if (!('oneof' in spec)) continue;
    variants++;
    assert.deepEqual(toolSchemaRefs(field(spec.no)), []);
    assert.throws(() => toolSchemaRefs(field(spec.no, Buffer.from([255]))));
    assert.throws(() => toolSchemaRefs(varint(spec.no * 8)));

    assert.throws(() =>
      toolSchemaRefs(Buffer.concat([field(spec.no), field(spec.no)])),
    );

    const other = spec.no === 1 ? 3 : 1;

    assert.throws(() =>
      toolSchemaRefs(Buffer.concat([field(spec.no), field(other)])),
    );
  }

  assert.equal(variants, 72);
});

test('TaskSuccess conversation steps carry recursive read and truncated dependencies', () => {
  const content = Buffer.alloc(32, 0xab);
  const original = Buffer.alloc(32, 0xcd);
  const read = field(8, field(2, field(1, field(10, content))));

  const truncated = field(
    34,
    Buffer.concat([field(1, original), field(5, read)]),
  );

  const task = field(
    19,
    field(
      2,
      field(
        1,
        Buffer.concat([
          field(1, field(2, read)),
          field(1, field(2, truncated)),
        ]),
      ),
    ),
  );

  const before = Buffer.from(task);

  assert.deepEqual(toolSchemaRefs(task), [
    { digest: content.toString('hex'), kind: 'scan', required: true },
    { digest: original.toString('hex'), kind: 'step', required: true },
    { digest: content.toString('hex'), kind: 'scan', required: true },
  ]);

  assert.deepEqual(task, before);

  assert.throws(() =>
    toolSchemaRefs(field(19, field(2, field(1, field(1, Buffer.from([255])))))),
  );
});

test('MCP inline bytes, shell stdout and edit text never become dependencies', () => {
  const opaque = Buffer.alloc(32, 0xab);

  for (const bytes of [
    field(1, field(2, field(1, field(5, opaque)))),
    field(12, field(2, field(1, field(7, opaque)))),
    field(15, field(2, field(1, field(1, field(1, field(1, opaque)))))),
  ]) {
    const before = Buffer.from(bytes);

    assert.deepEqual(toolSchemaRefs(bytes), []);
    assert.deepEqual(bytes, before);
  }
});
