import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeState,
  field1Candidates,
  readFields,
} from '../src/conversation-state';
import {
  blobKeysFromComposerBody,
  decodeSqliteBytes,
  encodeSqliteBytes,
  missingDependencyMessage,
  parseExportResources,
} from '../src/dependencies';
import { sqliteResourceLiteral } from '../src/db';
import { assertExportShape } from '../src/format';

/** Prefix sqlite resource bytes with the project's `~` marker. */
const encode = (bytes: Buffer) => '~' + bytes.toString('base64');

test('field 1 candidates retain order and duplicates', () => {
  const record = Buffer.concat([Buffer.from([10, 32]), Buffer.alloc(32, 97)]);

  assert.deepEqual(field1Candidates(encode(Buffer.concat([record, record]))), [
    '61'.repeat(32),
    '61'.repeat(32),
  ]);
});

test('turn blob ids are dependencies and 32-byte read paths are not', () => {
  const turn = Buffer.alloc(32, 7);
  const readPath = Buffer.alloc(32, 8);

  const found = blobKeysFromComposerBody(
    JSON.stringify({
      _v: 18,
      conversationState: encode(
        Buffer.concat([
          Buffer.from([66, 32]),
          turn,
          Buffer.from([146, 1, 32]),
          readPath,
        ]),
      ),
    }),
  );

  assert.equal(found.status, 'ok');
  assert.deepEqual(found.keys, [`agentKv:blob:${turn.toString('hex')}`]);
});

test('other 32-byte fields are not automatically dependencies', () => {
  assert.deepEqual(
    field1Candidates(
      encode(Buffer.concat([Buffer.from([66, 32]), Buffer.alloc(32)])),
    ),
    [],
  );
});

test('malformed wire data and base64 fail closed', () => {
  for (const bytes of [[10, 32, 1], [0], [11], Array(10).fill(255)]) {
    assert.throws(() => [...readFields(Buffer.from(bytes))]);
  }

  for (const value of ['~%', '~YQ', '~YR==', 'unmarked']) {
    assert.throws(() => decodeState(value));
  }
});

test('empty state is parsed without inventing dependencies', () => {
  assert.deepEqual(field1Candidates('~'), []);
});

test('sqliteResourceLiteral preserves storage class', () => {
  const bytes = Buffer.from([0, 255, 128, 10, 65]);

  assert.equal(sqliteResourceLiteral(bytes, 'blob'), "X'00ff800a41'");

  assert.equal(
    sqliteResourceLiteral(bytes, 'text'),
    "CAST(X'00ff800a41' AS TEXT)",
  );
});

test('resource envelope rejects bad checksum and non-canonical base64', () => {
  const bytes = Buffer.from('ok');
  const envelope = encodeSqliteBytes(bytes, 'blob');

  assert.throws(
    () => decodeSqliteBytes({ ...envelope, sha256: '00'.repeat(32) }),
    /checksum/i,
  );

  assert.throws(
    () =>
      decodeSqliteBytes({
        ...envelope,
        base64: envelope.base64 + '\n',
        byteLength: bytes.length,
      }),
    /base64|byteLength/i,
  );
});

test('unknown composer version with state is unsupported, not complete', () => {
  const found = blobKeysFromComposerBody(
    JSON.stringify({ _v: 99, conversationState: '~' }),
  );

  assert.equal(found.status, 'unsupported');
  assert.equal(found.keys.length, 0);
});

test('_v 18 without conversationState has no blob dependencies', () => {
  const found = blobKeysFromComposerBody(
    JSON.stringify({ _v: 18, composerId: 'x' }),
  );

  assert.equal(found.status, 'ok');
  assert.deepEqual(found.keys, []);
});

test('legacy format 2 remains readable and format 3 is accepted', () => {
  const base = {
    allComposers: [{ composerId: '11111111-1111-4111-8111-111111111111' }],
    composers: {},
    bubbles: {},
  };

  assert.equal(
    assertExportShape({ ...base, formatVersion: 2 }).formatVersion,
    2,
  );

  assert.equal(
    assertExportShape({ ...base, formatVersion: 3 }).formatVersion,
    3,
  );

  assert.throws(() => assertExportShape({ ...base, formatVersion: 1 }));
});

test('disallowed resource keys are rejected', () => {
  assert.throws(
    () =>
      parseExportResources({
        kv: [
          {
            key: 'agentKv:other:00',
            value: encodeSqliteBytes(Buffer.from('x'), 'blob'),
          },
        ],
        attachments: [],
      }),
    /not allowed/i,
  );
});

test('omitted resources.plans parses as an empty list', () => {
  const parsed = parseExportResources({ kv: [], attachments: [] });

  assert.deepEqual(parsed.plans, []);
  assert.deepEqual(parsed.canvases, []);
});

test('missing-dependency copy includes a measured count', () => {
  const text = missingDependencyMessage({
    status: 'incomplete',
    missingKeys: ['a', 'b'],
    missingAttachments: ['c'],
    missingPlans: [],
    missingCanvases: [],
  });

  assert.match(text, /Export it again/);
  assert.match(text, /3/);
});

test('valid 4 MiB resource below the declared limit decodes without regex stack overflow', () => {
  const original = Buffer.alloc(4 * 1024 * 1024, 97);

  assert.deepEqual(
    decodeSqliteBytes(encodeSqliteBytes(original, 'blob')),
    original,
  );
});

test('partial parse skips bad checksums but still rejects forbidden keys', () => {
  const envelope = encodeSqliteBytes(Buffer.from('ok'), 'blob');

  const parsed = parseExportResources(
    {
      kv: [
        {
          key: `agentKv:blob:${envelope.sha256}`,
          value: { ...envelope, sha256: '00'.repeat(32) },
        },
      ],
      attachments: [],
    },
    { skipInvalidPayloads: true },
  );

  assert.equal(parsed.kv.length, 0);

  assert.throws(
    () =>
      parseExportResources(
        {
          kv: [
            {
              key: 'agentKv:other:00',
              value: envelope,
            },
          ],
          attachments: [],
        },
        { skipInvalidPayloads: true },
      ),
    /not allowed/i,
  );
});
