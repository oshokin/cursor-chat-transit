import test from 'node:test';
import assert from 'node:assert/strict';
import { cloneExportObjectForCopy } from '../src/transfer';
import {
  conversationStateIds,
  remapConversationStateIds,
} from '../src/conversation-state';
import { assertCanonicalClientRowId } from '../src/client-row-key';
import { bubbleFromFields } from '../src/db';

/** Composer id used as the source chat in clone fixtures. */
const A = '11111111-1111-4111-8111-111111111111';
/** Bubble id referenced from ordered headers. */
const B = '22222222-2222-4222-8222-222222222222';
/** Second bubble id in the ordered conversation. */
const C = '33333333-3333-4333-8333-333333333333';
/** Spare UUID for tests that need a fourth id. */
const D = '44444444-4444-4444-8444-444444444444';

test('opaque conversation state remaps fixed-width chat and bubble ids', () => {
  const field = (value: string) =>
    Buffer.concat([
      Buffer.from([0x0a, Buffer.byteLength(value)]),
      Buffer.from(value),
    ]);

  const state = `~${Buffer.concat([field(A), field(`path/${A}`), field(B)]).toString('base64')}`;

  const remapped = remapConversationStateIds(
    state,
    new Map([
      [A, C],
      [B, D],
    ]),
  );

  assert.equal(
    Buffer.from(String(remapped).slice(1), 'base64').toString('hex'),
    Buffer.concat([field(C), field(`path/${A}`), field(D)]).toString('hex'),
  );
});

test('clone remaps opaque conversation state with its generated ids', async () => {
  const input = payload();
  const body = JSON.parse(input.composers[A]) as Record<string, unknown>;

  body.conversationState = `~${Buffer.concat(
    [A, B].map((id) =>
      Buffer.concat([
        Buffer.from([0x0a, Buffer.byteLength(id)]),
        Buffer.from(id),
      ]),
    ),
  ).toString('base64')}`;

  input.composers[A] = JSON.stringify(body);

  const { cloned } = await cloneExportObjectForCopy(input);
  const composer = cloned.allComposers[0].composerId;
  const bubble = cloned.bubbles?.[composer][0].bubbleId;

  const copied = JSON.parse(cloned.composers[composer]) as {
    conversationState: string;
  };

  const state = Buffer.from(
    copied.conversationState.slice(1),
    'base64',
  ).toString();

  assert.equal(state.includes(composer), true);
  assert.equal(state.includes(bubble || ''), true);
});

test('clone preserves canonical stream and repeated tool suffixes under the remapped root', async () => {
  const input = payload();
  const root = input.bubbles[A][0];

  for (const suffix of ['s:1', 't:call', 't2:call', 't17:other']) {
    const bubbleId = `${root.bubbleId}/${suffix}`;

    input.bubbles[A].push({
      key: `bubbleId:${A}:${bubbleId}`,
      bubbleId,
      value: JSON.stringify({
        _v: 3,
        bubbleId,
        type: 2,
      }),
    });
  }

  const { cloned } = await cloneExportObjectForCopy(input);
  const composer = cloned.allComposers[0].composerId;
  const rows = cloned.bubbles?.[composer] || [];
  const remappedRoot = rows[0].bubbleId;

  assert.equal(rows[2].bubbleId, `${remappedRoot}/s:1`);
  assert.equal(rows[3].bubbleId, `${remappedRoot}/t:call`);
  assert.equal(rows[4].bubbleId, `${remappedRoot}/t2:call`);
  assert.equal(rows[5].bubbleId, `${remappedRoot}/t17:other`);
  for (const row of rows.slice(2))
    assert.equal(JSON.parse(row.value).bubbleId, row.bubbleId);
});

test('clone accepts nested rows before their root and rejects inconsistent prepared ids', async () => {
  const input = payload();
  const root = input.bubbles[A][0];

  const nested = {
    key: `${root.key}/s:1`,
    bubbleId: `${root.bubbleId}/s:1`,
    value: JSON.stringify({
      _v: 3,
      bubbleId: `${root.bubbleId}/s:1`,
      type: 2,
    }),
  };

  input.bubbles[A].unshift(nested);
  const copied = await cloneExportObjectForCopy(input);
  const composer = copied.cloned.allComposers[0].composerId;
  const rows = copied.cloned.bubbles?.[composer] || [];
  const rootId = rows.find((row) => !row.bubbleId.includes('/'))!.bubbleId;

  assert.equal(rows[0].bubbleId, `${rootId}/s:1`);

  await assert.rejects(
    cloneExportObjectForCopy(input, {
      bubbleMap: new Map([
        [`${A}\0${root.bubbleId}`, C],
        [`${A}\0${nested.bubbleId}`, D],
      ]),
    }),
    /inconsistent nested target/i,
  );
});

test('clone accepts standalone canonical rows and preserves checkpoint order', async () => {
  const input = payload();
  const turn = '55555555-5555-4555-8555-555555555555';
  const ids = [`${turn}/s:17`, `${turn}/s:2`, `${turn}/u`];

  input.bubbles[A] = ids.map((bubbleId) => ({
    key: `bubbleId:${A}:${bubbleId}`,
    bubbleId,
    value: JSON.stringify({ _v: 3, bubbleId, type: 2 }),
  }));

  const body = JSON.parse(input.composers[A]) as Record<string, unknown>;

  body.fullConversationHeadersOnly = ids.map((bubbleId) => ({ bubbleId }));
  input.composers[A] = JSON.stringify(body);

  const { cloned } = await cloneExportObjectForCopy(input);
  const composer = cloned.allComposers[0].composerId;
  const rows = cloned.bubbles?.[composer] || [];
  const mappedRoot = rows[0].bubbleId.slice(0, rows[0].bubbleId.indexOf('/'));

  assert.deepEqual(
    rows.map((row) => row.bubbleId),
    [`${mappedRoot}/s:17`, `${mappedRoot}/s:2`, `${mappedRoot}/u`],
  );

  assert.deepEqual(
    (
      JSON.parse(cloned.composers[composer]) as {
        fullConversationHeadersOnly: Array<{ bubbleId: string }>;
      }
    ).fullConversationHeadersOnly.map((header) => header.bubbleId),
    rows.map((row) => row.bubbleId),
  );

  const preparedRoot = D;

  const retried = await cloneExportObjectForCopy(input, {
    bubbleMap: new Map([
      [`${A}\0${ids[0]}`, `${preparedRoot}/s:17`],
      [`${A}\0${ids[1]}`, `${preparedRoot}/s:2`],
      [`${A}\0${ids[2]}`, `${preparedRoot}/u`],
    ]),
  });

  assert.deepEqual(
    retried.cloned.bubbles?.[retried.cloned.allComposers[0].composerId].map(
      (row) => row.bubbleId,
    ),
    [`${preparedRoot}/s:17`, `${preparedRoot}/s:2`, `${preparedRoot}/u`],
  );
});

test('Cursor client-row grammar accepts canonical IDs and rejects ambiguous spellings', () => {
  for (const id of [
    B,
    `${B}/u`,
    `${B}/s:0`,
    `${B}/s:17`,
    `${B}/t:call-id`,
    `${B}/t2:call-id`,
    `${B}/t17:call-id`,
  ])
    assert.doesNotThrow(() => assertCanonicalClientRowId(id));

  for (const id of [
    `${B}/`,
    `${B}/s:`,
    `${B}/s:-1`,
    `${B}/s:01`,
    `${B}/t:`,
    `${B}/t1:call`,
    `${B}/t0:call`,
    `${B}/s:1/extra`,
    `/s:0`,
  ])
    assert.throws(() => assertCanonicalClientRowId(id), /client-row/i);
});

test('SQLite bubble decoding keeps colons and client-row suffixes in the exact ID', () => {
  for (const bubbleId of [`${B}/s:17`, `${B}/t:call:id`, `${B}/t2:call:id`]) {
    const key = `bubbleId:${A}:${bubbleId}`;

    assert.deepEqual(
      bubbleFromFields([
        Buffer.from(key),
        Buffer.from('text'),
        Buffer.from(JSON.stringify({ bubbleId })),
      ]),
      {
        key,
        bubbleId,
        value: JSON.stringify({ bubbleId }),
      },
    );
  }
});

test('clone rejects body IDs that differ from their exact canonical storage ID', async () => {
  const input = payload();
  const root = input.bubbles[A][0];
  const nestedId = `${root.bubbleId}/s:0`;

  input.bubbles[A].push({
    key: `bubbleId:${A}:${nestedId}`,
    bubbleId: nestedId,
    value: JSON.stringify({ _v: 3, bubbleId: root.bubbleId, type: 2 }),
  });

  await assert.rejects(cloneExportObjectForCopy(input), /body ID mismatch/i);
});

test('state remapping preserves unknown fields byte-for-byte and only rewrites exact UUID strings', () => {
  const len = (field: number, bytes: Buffer) =>
    Buffer.concat([Buffer.from([(field << 3) | 2, bytes.length]), bytes]);

  const unknownVarint = Buffer.from([0x78, 0xac, 0x02]);
  const nested = len(3, Buffer.concat([len(2, Buffer.from(B)), unknownVarint]));

  const original = Buffer.concat([
    unknownVarint,
    len(1, Buffer.from(A)),
    len(4, Buffer.from(`prefix-${A}`)),
    nested,
  ]);

  const state = `~${original.toString('base64')}`;

  const remapped = String(
    remapConversationStateIds(
      state,
      new Map([
        [A, C],
        [B, D],
      ]),
    ),
  );

  const expected = Buffer.concat([
    unknownVarint,
    len(1, Buffer.from(C)),
    len(4, Buffer.from(`prefix-${A}`)),
    len(3, Buffer.concat([len(2, Buffer.from(D)), unknownVarint])),
  ]);

  assert.equal(
    Buffer.from(remapped.slice(1), 'base64').toString('hex'),
    expected.toString('hex'),
  );

  assert.deepEqual(conversationStateIds(remapped), new Set([C, D]));
});

test('state remapping preserves every supported unknown protobuf wire type', () => {
  const fixed64 = Buffer.concat([Buffer.from([0x09]), Buffer.alloc(8, 0xa1)]);
  const fixed32 = Buffer.concat([Buffer.from([0x15]), Buffer.alloc(4, 0xb2)]);

  const duplicateRaw = Buffer.concat([
    Buffer.from([0x1a, 0x03]),
    Buffer.from([0xff, 0x00, 0x7f]),
  ]);

  const uuid = Buffer.concat([Buffer.from([0x22, A.length]), Buffer.from(A)]);

  const bytes = Buffer.concat([
    Buffer.from([0x08, 0xac, 0x02]),
    fixed64,
    fixed32,
    duplicateRaw,
    duplicateRaw,
    uuid,
  ]);

  const remapped = String(
    remapConversationStateIds(
      `~${bytes.toString('base64')}`,
      new Map([[A, C]]),
    ),
  );

  const expected = Buffer.concat([
    Buffer.from([0x08, 0xac, 0x02]),
    fixed64,
    fixed32,
    duplicateRaw,
    duplicateRaw,
    Buffer.from([0x22, C.length]),
    Buffer.from(C),
  ]);

  assert.equal(
    Buffer.from(remapped.slice(1), 'base64').toString('hex'),
    expected.toString('hex'),
  );
});

/** Minimal export object whose conversation headers must remap together. */
function payload() {
  return {
    formatVersion: 2,
    allComposers: [{ composerId: A, name: 'Fixture' }],
    composers: {
      [A]: JSON.stringify({
        _v: 18,
        composerId: A,
        name: 'Fixture',
        fullConversationHeadersOnly: [
          {
            bubbleId: B,
            type: 1,
            serverBubbleId: B,
            grouping: { textPreview: B },
            createdAt: 7,
          },
          { bubbleId: C, type: 2 },
        ],
        originalFileStates: {
          'file:///fixture.ts': { firstEditBubbleId: C, extra: true },
        },
        text: B,
      }),
    },
    bubbles: {
      [A]: [B, C].map((bubbleId) => ({
        key: `bubbleId:${A}:${bubbleId}`,
        bubbleId,
        value: JSON.stringify({
          _v: 3,
          bubbleId,
          text: `Keep ${bubbleId}`,
          serverBubbleId: bubbleId,
        }),
      })),
    },
  };
}

test('every ordered conversation header resolves after clone', async () => {
  const { cloned } = await cloneExportObjectForCopy(payload());
  const id = cloned.allComposers[0].composerId;

  const body = JSON.parse(cloned.composers[id]) as {
    fullConversationHeadersOnly: Array<{
      bubbleId: string;
      serverBubbleId: string;
      grouping?: { textPreview: string };
      createdAt?: number;
      type: number;
    }>;
    text: string;
    name: string;
  };

  const ids = new Set(cloned.bubbles?.[id].map((b) => b.bubbleId));

  assert.equal(
    body.fullConversationHeadersOnly.filter((h) => !ids.has(h.bubbleId)).length,
    0,
  );

  assert.equal(body.fullConversationHeadersOnly.length, 2);

  assert.equal(
    body.fullConversationHeadersOnly[0].bubbleId,
    cloned.bubbles?.[id][0].bubbleId,
  );

  assert.equal(body.fullConversationHeadersOnly[0].type, 1);
  assert.equal(body.fullConversationHeadersOnly[0].createdAt, 7);
  assert.equal(body.text, B);
  assert.equal(body.name, 'Fixture');
  assert.equal(body.fullConversationHeadersOnly[0].serverBubbleId, B);
  assert.equal(body.fullConversationHeadersOnly[0].grouping?.textPreview, B);

  const first = JSON.parse(cloned.bubbles?.[id][0].value || '{}') as {
    text: string;
    serverBubbleId: string;
  };

  assert.equal(first.text, `Keep ${B}`);
  assert.equal(first.serverBubbleId, B);
});

test('firstEditBubbleId uses the same per-composer map', async () => {
  const { cloned } = await cloneExportObjectForCopy(payload());
  const id = cloned.allComposers[0].composerId;

  const body = JSON.parse(cloned.composers[id]) as {
    originalFileStates: Record<
      string,
      { firstEditBubbleId: string; extra: boolean }
    >;
  };

  assert.equal(
    body.originalFileStates['file:///fixture.ts'].firstEditBubbleId,
    cloned.bubbles?.[id][1].bubbleId,
  );

  assert.equal(body.originalFileStates['file:///fixture.ts'].extra, true);
});

test('dangling ordered header is rejected before import', async () => {
  const input = payload();

  input.bubbles[A].pop();

  await assert.rejects(
    () => cloneExportObjectForCopy(input),
    /reference|missing.*message|missing.*bubble|incomplete/i,
  );
});

test('mismatched wrapper key is rejected before import', async () => {
  const input = payload();

  input.bubbles[A][0].key = `bubbleId:${A}:${C}`;

  await assert.rejects(
    () => cloneExportObjectForCopy(input),
    /key|mismatch|invalid/i,
  );
});

test('the same old bubbleId in two chats stays scoped after clone', async () => {
  const second = {
    formatVersion: 2,
    allComposers: [
      { composerId: A, name: 'One' },
      { composerId: D, name: 'Two' },
    ],
    composers: {
      [A]: JSON.stringify({
        _v: 18,
        composerId: A,
        fullConversationHeadersOnly: [{ bubbleId: B }],
      }),
      [D]: JSON.stringify({
        _v: 18,
        composerId: D,
        fullConversationHeadersOnly: [{ bubbleId: B }],
      }),
    },
    bubbles: {
      [A]: [
        {
          key: `bubbleId:${A}:${B}`,
          bubbleId: B,
          value: JSON.stringify({ _v: 3, bubbleId: B, text: 'alpha' }),
        },
      ],
      [D]: [
        {
          key: `bubbleId:${D}:${B}`,
          bubbleId: B,
          value: JSON.stringify({ _v: 3, bubbleId: B, text: 'beta' }),
        },
      ],
    },
  };

  const { cloned } = await cloneExportObjectForCopy(second);
  const idA = cloned.allComposers[0].composerId;
  const idD = cloned.allComposers[1].composerId;

  const headerA = (
    JSON.parse(cloned.composers[idA]) as {
      fullConversationHeadersOnly: Array<{ bubbleId: string }>;
    }
  ).fullConversationHeadersOnly[0].bubbleId;

  const headerD = (
    JSON.parse(cloned.composers[idD]) as {
      fullConversationHeadersOnly: Array<{ bubbleId: string }>;
    }
  ).fullConversationHeadersOnly[0].bubbleId;

  assert.notEqual(headerA, headerD);
  assert.equal(headerA, cloned.bubbles?.[idA][0].bubbleId);
  assert.equal(headerD, cloned.bubbles?.[idD][0].bubbleId);

  assert.equal(
    JSON.parse(cloned.bubbles?.[idA][0].value || '{}').text,
    'alpha',
  );

  assert.equal(JSON.parse(cloned.bubbles?.[idD][0].value || '{}').text, 'beta');
});
