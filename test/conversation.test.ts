import test from 'node:test';
import assert from 'node:assert/strict';
import { cloneExportObjectForCopy } from '../src/transfer';

/** Composer id used as the source chat in clone fixtures. */
const A = '11111111-1111-4111-8111-111111111111';
/** Bubble id referenced from ordered headers. */
const B = '22222222-2222-4222-8222-222222222222';
/** Second bubble id in the ordered conversation. */
const C = '33333333-3333-4333-8333-333333333333';
/** Spare UUID for tests that need a fourth id. */
const D = '44444444-4444-4444-8444-444444444444';

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
