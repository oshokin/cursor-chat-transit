import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeState,
  conversationStateIds,
  remapConversationStateIds,
} from '../src/conversation-state';
import { resolveBlobGraph } from '../src/blob-graph';
import { blobKeysFromComposerBody } from '../src/chat-dependencies';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

const field = (n: number, bytes: Buffer): Buffer =>
  Buffer.concat([
    Buffer.from(
      n < 16 ? [(n << 3) | 2] : [(((n << 3) | 2) & 127) | 128, n >> 4],
    ),
    Buffer.from([bytes.length]),
    bytes,
  ]);

test('hex renderer state is bounded and decoded like base64', () => {
  const bytes = field(1, Buffer.alloc(32, 0xab));

  assert.deepEqual(
    decodeState(` ${bytes.toString('hex').toUpperCase()} `),
    bytes,
  );

  assert.deepEqual(
    blobKeysFromComposerBody(
      JSON.stringify({ _v: 18, conversationState: bytes.toString('hex') }),
    ),
    {
      status: 'ok',
      keys: [`agentKv:blob:${'ab'.repeat(32)}`],
    },
  );

  for (const bad of ['a', 'zz', '0x12', '12 34'])
    assert.throws(() => decodeState(bad));
});

test('only typed subagent map keys remap in both encodings', () => {
  const entry = field(1, Buffer.from(A));
  const text = field(4, Buffer.from(A));
  const state = Buffer.concat([field(31, entry), text]);
  const expected = Buffer.concat([field(31, field(1, Buffer.from(B))), text]);

  for (const encode of [
    (b: Buffer) => b.toString('hex'),
    (b: Buffer) => `~${b.toString('base64')}`,
  ]) {
    assert.deepEqual(conversationStateIds(encode(state)), new Set([A]));

    assert.deepEqual(
      decodeState(remapConversationStateIds(encode(state), new Map([[A, B]]))),
      expected,
    );
  }
});

test('present decoy digests in opaque blobs are never dependencies', () => {
  const rootId = 'ab'.repeat(32);
  const decoyId = 'cd'.repeat(32);

  const result = resolveBlobGraph(
    field(1, Buffer.from(rootId, 'hex')).toString('hex'),
    new Map([
      [rootId, field(99, Buffer.from(decoyId, 'hex'))],
      [decoyId, Buffer.from('unrelated')],
    ]),
  );

  assert.deepEqual(result, {
    status: 'ok',
    keys: [`agentKv:blob:${rootId}`],
    missing: [],
  });
});

test('unimplemented tool-call closure fails explicitly instead of guessing', () => {
  const turnId = 'ab'.repeat(32);
  const stepId = 'cd'.repeat(32);

  const result = resolveBlobGraph(
    field(8, Buffer.from(turnId, 'hex')).toString('hex'),
    new Map([
      [turnId, field(1, field(2, Buffer.from(stepId, 'hex')))],
      [stepId, field(2, field(99, Buffer.alloc(0)))],
    ]),
  );

  assert.equal(result.status, 'unsupported');
});
