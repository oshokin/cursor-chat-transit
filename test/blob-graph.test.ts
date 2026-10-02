import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveBlobGraph } from '../src/blob-graph';
import { agentChatFixture, digest } from './blob-fixture';

/** Protobuf varint. */
function varint(value: number): Buffer {
  const out: number[] = [];
  let n = value;

  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }

  out.push(n);

  return Buffer.from(out);
}

/** Length-delimited protobuf field. */
function field(number: number, payload: Buffer): Buffer {
  return Buffer.concat([
    varint((number << 3) | 2),
    varint(payload.length),
    payload,
  ]);
}

/** 32-byte blob id field. */
function blob(number: number, id: string): Buffer {
  return field(number, Buffer.from(id, 'hex'));
}

test('a turn pulls user message, steps, tool bytes, and file state', () => {
  const chat = agentChatFixture();
  const closed = resolveBlobGraph(chat.state, chat.blobs);

  assert.equal(closed.status, 'ok');

  assert.deepEqual(
    closed.keys.map((key) => key.slice('agentKv:blob:'.length)).sort(),
    [...chat.present].sort(),
  );

  assert.deepEqual(closed.missing, [`agentKv:blob:${chat.missing}`]);

  assert.equal(
    closed.keys.some((key) => key.endsWith(chat.decoy)),
    false,
  );

  assert.equal(
    closed.keys.some((key) => key.endsWith(chat.readPath)),
    false,
  );
});

test('nested conversation_state_blob_id is walked', () => {
  const innerTurn = field(9, Buffer.from('not a blob id'));
  const innerId = digest(innerTurn);
  const nested = blob(8, innerId);
  const nestedId = digest(nested);
  const user = blob(10, nestedId);
  const userId = digest(user);
  const turn = field(1, blob(1, userId));
  const turnId = digest(turn);
  const state = `~${blob(8, turnId).toString('base64')}`;

  const closed = resolveBlobGraph(
    state,
    new Map([
      [turnId, turn],
      [userId, user],
      [nestedId, nested],
      [innerId, innerTurn],
    ]),
  );

  assert.deepEqual(
    closed.keys.map((key) => key.slice('agentKv:blob:'.length)).sort(),
    [innerId, nestedId, turnId, userId].sort(),
  );

  assert.deepEqual(closed.missing, []);
});

test('a missing step is incomplete and a missing loose hash is not', () => {
  const stepId = 'cd'.repeat(32);
  const looseId = 'ef'.repeat(32);
  const user = field(1, Buffer.from('hi'));
  const userId = digest(user);

  const turn = field(
    1,
    Buffer.concat([
      blob(1, userId),
      blob(2, stepId),
      field(9, Buffer.from(looseId, 'hex')),
    ]),
  );

  const turnId = digest(turn);

  const closed = resolveBlobGraph(
    `~${blob(8, turnId).toString('base64')}`,
    new Map([
      [turnId, turn],
      [userId, user],
    ]),
  );

  assert.deepEqual(
    closed.keys.map((key) => key.slice('agentKv:blob:'.length)).sort(),
    [turnId, userId].sort(),
  );

  assert.deepEqual(closed.missing, [`agentKv:blob:${stepId}`]);
});

test('a missing loose reference later required by a nested state stays missing', () => {
  const missing = 'ab'.repeat(32);
  const nested = blob(3, missing);
  const nestedId = digest(nested);
  const user = blob(10, nestedId);
  const userId = digest(user);
  const turn = field(1, blob(1, userId));
  const turnId = digest(turn);
  const loose = blob(99, missing);
  const looseId = digest(loose);

  const closed = resolveBlobGraph(
    `~${Buffer.concat([blob(1, looseId), blob(8, turnId)]).toString('base64')}`,
    new Map([
      [looseId, loose],
      [turnId, turn],
      [userId, user],
      [nestedId, nested],
    ]),
  );

  assert.deepEqual(closed.missing, [`agentKv:blob:${missing}`]);
});

test('a previously scanned blob is reparsed when it becomes a typed user message', () => {
  const missing = 'cd'.repeat(32);
  const user = blob(18, missing);
  const userId = digest(user);
  const turn = field(1, blob(1, userId));
  const turnId = digest(turn);

  const closed = resolveBlobGraph(
    `~${Buffer.concat([blob(1, userId), blob(8, turnId)]).toString('base64')}`,
    new Map([
      [userId, user],
      [turnId, turn],
    ]),
  );

  assert.deepEqual(closed.missing, [`agentKv:blob:${missing}`]);
});

test('malformed required protobuf is unsupported, not a complete empty closure', () => {
  const bad = Buffer.from([0xff]);
  const id = digest(bad);

  const closed = resolveBlobGraph(
    `~${blob(8, id).toString('base64')}`,
    new Map([[id, bad]]),
  );

  assert.equal(closed.status, 'unsupported');
});

test('asynchronous graph traversal bounds a wide frontier to one payload per read', async () => {
  const { readBlobGraph } = await import('../src/blob-graph');

  const ids = Array.from({ length: 200 }, (_, i) =>
    digest(Buffer.from(`text-${i}`)),
  );

  const closed = await readBlobGraph(
    `~${Buffer.concat(ids.map((id) => blob(1, id))).toString('base64')}`,
    async (wanted) => {
      assert.equal(wanted.length, 1);

      return new Map([[wanted[0]!, Buffer.alloc(128 * 1024, 0x78)]]);
    },
  );

  assert.equal(closed.keys.length, 200);
  assert.equal(closed.status, 'ok');
});

test('batched graph traversal accepts byte-bounded prefixes without losing keys', async () => {
  const { readBlobGraph } = await import('../src/blob-graph');

  const ids = Array.from({ length: 70 }, (_, i) =>
    digest(Buffer.from(`batch-${i}`)),
  );

  let calls = 0;

  const result = await readBlobGraph(
    `~${Buffer.concat(ids.map((id) => blob(1, id))).toString('base64')}`,
    async (wanted) => {
      assert.ok(wanted.length <= 32);
      calls++;

      return new Map(wanted.slice(0, 7).map((id) => [id, Buffer.from('text')]));
    },
    32,
  );

  assert.equal(calls, 10);

  assert.deepEqual(
    result.keys,
    ids.map((id) => `agentKv:blob:${id}`),
  );

  assert.deepEqual(result.missing, []);
});

test('batched graph traversal fails a non-progressing reader instead of looping', async () => {
  const { readBlobGraph } = await import('../src/blob-graph');

  await assert.rejects(
    readBlobGraph(
      `~${blob(1, 'ab'.repeat(32)).toString('base64')}`,
      async () => new Map(),
      32,
    ),
    /no progress/,
  );
});
