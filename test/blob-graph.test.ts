import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveBlobGraph } from '../src/blob-graph';
import { agentChatFixture, digest } from './blob-fixture';
import { descriptorRefs } from '../src/blob-descriptors';
import schemas from '../src/cursor-tool-schemas.json';

test('installed Glob, Grep and CommunicateUpdate wrappers keep inline results opaque', () => {
  for (const [number, args, success] of [
    [4, [1, 2], [1, 2, 3, 4, 5, 6]],
    [5, Array.from({ length: 16 }, (_, i) => i + 1), [1, 2, 3, 4, 5]],
    [48, [1, 3, 4], [1, 3]],
  ] as const) {
    const inline = blob(1, 'ab'.repeat(32));
    const wrapper = schemas['agent.v1.ToolCall'].find((f) => f.no === number)!;

    const schema = (
      schemas as Record<
        string,
        { no: number; wire: number; message?: string }[]
      >
    )[wrapper.message!]!;

    const encode = (numbers: readonly number[], name: string): Buffer =>
      Buffer.concat(
        numbers.map((n) => {
          const spec = (
            schemas as Record<
              string,
              { no: number; wire: number; message?: string }[]
            >
          )[name]!.find((f) => f.no === n)!;

          return spec.wire === 2
            ? field(n, spec.message ? Buffer.alloc(0) : inline)
            : Buffer.concat([
                varint(n * 8 + spec.wire),
                Buffer.alloc(spec.wire === 1 ? 8 : spec.wire === 5 ? 4 : 1),
              ]);
        }),
      );

    const resultSchema = (
      schemas as Record<
        string,
        { no: number; wire: number; message?: string }[]
      >
    )[schema.find((f) => f.no === 2)!.message!]!;

    for (const result of [
      field(1, encode(success, resultSchema.find((f) => f.no === 1)!.message!)),
      field(2, field(1, inline)),
    ]) {
      const call = field(
        number,
        Buffer.concat([
          field(1, encode(args, schema.find((f) => f.no === 1)!.message!)),
          field(2, result),
        ]),
      );

      assert.deepEqual(descriptorRefs('tool', call), []);
      assert.deepEqual(descriptorRefs('tool', field(34, field(5, call))), []);
    }

    for (const malformed of [
      field(number, field(3, Buffer.alloc(0))),
      field(number, field(2, field(3, Buffer.alloc(0)))),
      field(
        number,
        field(
          2,
          Buffer.concat([field(1, Buffer.alloc(0)), field(2, Buffer.alloc(0))]),
        ),
      ),
      field(number, field(1, Buffer.from([0xff]))),
      field(number, Buffer.from([0x10, 0])),
      Buffer.concat([
        field(number, Buffer.alloc(0)),
        field(8, Buffer.alloc(0)),
      ]),
    ])
      assert.throws(() => descriptorRefs('tool', malformed));
  }
});

test('Grep preview preserves truncated original missing and malformed dependencies', () => {
  const original = field(
    2,
    field(5, field(2, field(1, field(1, Buffer.from('pattern'))))),
  );

  const originalId = digest(original);

  const step = field(
    2,
    field(
      34,
      Buffer.concat([blob(1, originalId), field(5, field(5, Buffer.alloc(0)))]),
    ),
  );

  const stepId = digest(step);
  const turn = field(1, blob(2, stepId));
  const turnId = digest(turn);
  const state = `~${blob(8, turnId).toString('base64')}`;

  const blobs = new Map([
    [turnId, turn],
    [stepId, step],
  ]);

  assert.deepEqual(resolveBlobGraph(state, blobs).missing, [
    `agentKv:blob:${originalId}`,
  ]);

  blobs.set(originalId, original);
  assert.equal(resolveBlobGraph(state, blobs).status, 'ok');
  assert.deepEqual(resolveBlobGraph(state, blobs).missing, []);
  blobs.set(originalId, field(2, field(5, Buffer.from([0xff]))));
  assert.equal(resolveBlobGraph(state, blobs).status, 'unsupported');
});

test('installed read wrapper follows only success data/content blob ids', () => {
  for (const number of [9, 10]) {
    const id = 'ab'.repeat(32);

    const tool = field(
      8,
      field(
        2,
        field(1, Buffer.concat([blob(number, id), blob(7, 'cd'.repeat(32))])),
      ),
    );

    assert.deepEqual(descriptorRefs('tool', tool), [
      { digest: id, kind: 'scan', required: true },
    ]);
  }

  assert.deepEqual(
    descriptorRefs(
      'tool',
      field(8, field(2, field(2, blob(1, 'ab'.repeat(32))))),
    ),
    [],
  );
});

test('selected media direct and paired ids do not scan inline media', () => {
  for (const selection of [1, 23, 25]) {
    for (const paired of [false, true]) {
      const id = 'ab'.repeat(32);
      const media = paired ? field(9, blob(1, id)) : blob(1, id);

      assert.deepEqual(descriptorRefs('selected', field(selection, media)), [
        { digest: id, kind: 'scan', required: true },
      ]);
    }

    assert.deepEqual(
      descriptorRefs('selected', field(selection, blob(8, 'ab'.repeat(32)))),
      [],
    );
  }
});

test('selected context declares extra, invocation, link, PR and diff dependencies', () => {
  for (const [selection, number, kind] of [
    [16, 2, 'scan'],
    [2, 10, 'invocation'],
    [9, 6, 'scan'],
    [20, 6, 'diff'],
    [21, 7, 'pr'],
  ] as const) {
    const id = 'ab'.repeat(32);

    assert.deepEqual(
      descriptorRefs('selected', field(selection, blob(number, id))),
      [{ digest: id, kind, required: true }],
    );
  }
});

test('typed wrappers reject unknown, malformed, wrong-wire and invalid digest data', () => {
  for (const bytes of [
    field(99, Buffer.alloc(0)),
    Buffer.from([0xff]),
    field(8, Buffer.from([0xff])),
    field(8, field(2, field(1, field(9, Buffer.alloc(31))))),
    Buffer.from([0x40, 0]),
  ]) {
    assert.throws(() => descriptorRefs('tool', bytes));
  }

  assert.throws(() => descriptorRefs('selected', field(99, Buffer.alloc(0))));

  assert.throws(
    () =>
      descriptorRefs(
        'selected',
        field(
          25,
          Buffer.concat([blob(1, 'ab'.repeat(32)), blob(8, 'cd'.repeat(32))]),
        ),
      ),
    /oneof/,
  );
});

test('truncated original step reuses shared typed closure and preserves missing ids', () => {
  const missing = 'ab'.repeat(32);
  const original = field(2, field(8, field(2, field(1, blob(10, missing)))));
  const originalId = digest(original);
  const step = field(2, field(34, blob(1, originalId)));
  const stepId = digest(step);
  const turn = field(1, blob(2, stepId));
  const turnId = digest(turn);

  const result = resolveBlobGraph(
    `~${blob(8, turnId).toString('base64')}`,
    new Map([
      [turnId, turn],
      [stepId, step],
      [originalId, original],
    ]),
  );

  assert.equal(result.status, 'ok');
  assert.deepEqual(result.missing, [`agentKv:blob:${missing}`]);
  assert.equal(result.keys.length, 3);
});

test('truncated previews are bounded ToolCall wrappers', () => {
  let preview: Buffer = Buffer.alloc(0);

  for (let i = 0; i < 40; i++) preview = field(34, field(5, preview));
  assert.throws(() => descriptorRefs('tool', preview), /depth/);
});

test('selected dependencies share synchronous and asynchronous closure', async () => {
  const { readBlobGraph } = await import('../src/blob-graph');
  const payload = Buffer.from('opaque media');
  const id = digest(payload);
  const missing = 'ab'.repeat(32);

  const user = field(
    3,
    Buffer.concat([
      field(25, blob(1, id)),
      field(1, field(9, blob(1, missing))),
    ]),
  );

  const userId = digest(user);
  const turn = field(1, blob(1, userId));
  const turnId = digest(turn);
  const state = `~${blob(8, turnId).toString('base64')}`;

  const blobs = new Map([
    [turnId, turn],
    [userId, user],
    [id, payload],
  ]);

  const sync = resolveBlobGraph(state, blobs);

  const asyncResult = await readBlobGraph(
    state,
    async (ids) => new Map(ids.map((key) => [key, blobs.get(key) ?? null])),
  );

  assert.deepEqual(asyncResult, sync);
  assert.equal(sync.status, 'ok');
  assert.deepEqual(sync.missing, [`agentKv:blob:${missing}`]);
  assert.equal(sync.keys.length, 3);
});

test('unknown tool and malformed selected context fail shared closure closed', () => {
  for (const [role, value] of [
    [2, field(2, field(99, Buffer.alloc(0)))],
    [1, field(3, field(25, Buffer.from([0xff])))],
  ] as const) {
    const id = digest(value);
    const turn = field(1, blob(role, id));
    const turnId = digest(turn);

    const result = resolveBlobGraph(
      `~${blob(8, turnId).toString('base64')}`,
      new Map([
        [turnId, turn],
        [id, value],
      ]),
    );

    assert.equal(result.status, 'unsupported');
  }
});

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

test('typed closure ignores unrelated stored tool bytes', () => {
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
