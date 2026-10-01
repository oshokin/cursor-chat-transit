import test from 'node:test';
import assert from 'node:assert/strict';
import { cloneExportObjectForCopy } from '../src/transfer';
import { assertExportShape } from '../src/format';

test('remap keeps UUID text, timestamps and unknown fields; rewrites references', async () => {
  const oldC = '11111111-1111-4111-8111-111111111111';
  const oldB1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const oldB2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  const obj = {
    allComposers: [
      {
        composerId: oldC,
        name: 'Keep me',
        createdAt: 7,
        lastUpdatedAt: 9,
        mystery: true,
      },
    ],
    composers: {
      [oldC]: JSON.stringify({
        composerId: oldC,
        createdAt: 7,
        text: `mention ${oldC} in user text`,
        fullConversationHeadersByBubbleId: {
          [oldB1]: { bubbleId: oldB1 },
          [oldB2]: { bubbleId: oldB2 },
        },
      }),
    },
    bubbles: {
      [oldC]: [
        {
          bubbleId: oldB1,
          key: `bubbleId:${oldC}:${oldB1}`,
          value: JSON.stringify({
            composerId: oldC,
            bubbleId: oldB1,
            text: `do not rewrite ${oldC}`,
            nextBubbleId: oldB2,
          }),
        },
        {
          bubbleId: oldB2,
          key: `bubbleId:${oldC}:${oldB2}`,
          value: JSON.stringify({
            composerId: oldC,
            bubbleId: oldB2,
            text: 'second',
          }),
        },
      ],
    },
  };

  const { cloned } = await cloneExportObjectForCopy(obj);
  const newC = cloned.allComposers[0].composerId;

  assert.notEqual(newC, oldC);
  assert.equal(cloned.allComposers[0].createdAt, 7);
  assert.equal(cloned.allComposers[0].lastUpdatedAt, 9);
  assert.equal(cloned.allComposers[0].mystery, true);

  const body = JSON.parse(cloned.composers[newC]) as {
    composerId: string;
    text: string;
    fullConversationHeadersByBubbleId: Record<string, unknown>;
  };

  assert.equal(body.composerId, newC);
  assert.match(body.text, new RegExp(oldC));

  assert.equal(
    Object.keys(body.fullConversationHeadersByBubbleId).includes(oldB1),
    false,
  );

  const newBubbles = cloned.bubbles?.[newC] || [];

  const b1 = JSON.parse(newBubbles[0].value) as {
    text: string;
    nextBubbleId: string;
    bubbleId: string;
  };

  const b2 = JSON.parse(newBubbles[1].value) as { bubbleId: string };

  assert.equal(b1.text, `do not rewrite ${oldC}`);
  assert.equal(b1.nextBubbleId, b2.bubbleId);
  assert.notEqual(b1.bubbleId, oldB1);
});

test('malformed bubble JSON is rejected before copy', async () => {
  await assert.rejects(
    () =>
      cloneExportObjectForCopy({
        allComposers: [{ composerId: '11111111-1111-4111-8111-111111111111' }],
        composers: {
          '11111111-1111-4111-8111-111111111111': JSON.stringify({
            composerId: '11111111-1111-4111-8111-111111111111',
          }),
        },
        bubbles: {
          '11111111-1111-4111-8111-111111111111': [
            {
              bubbleId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              key: 'bubbleId:11111111-1111-4111-8111-111111111111:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              value: '{"broken"',
            },
          ],
        },
      }),
    /unsupported payload/,
  );
});

test('missing composer body is incomplete, not fabricated', async () => {
  const obj = {
    allComposers: [{ composerId: '11111111-1111-4111-8111-111111111111' }],
    composers: {},
    bubbles: {},
  };

  await assert.rejects(
    () => cloneExportObjectForCopy(obj),
    /Incomplete export/,
  );
});

/** Source composer id whose nested bubble pointers must remap together. */
const A = '11111111-1111-4111-8111-111111111111';
/** Second composer used when two chats share a bubble id. */
const B = '22222222-2222-4222-8222-222222222222';
/** Nested bubble id referenced from composer JSON. */
const X = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
/** Second nested bubble id. */
const Y = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/** Export whose composer JSON points at bubbles X and Y. */
function linkedPayload(ids = [A]) {
  return {
    allComposers: ids.map((composerId) => ({ composerId })),
    composers: Object.fromEntries(
      ids.map((id) => [
        id,
        JSON.stringify({
          composerId: id,
          fullConversationHeadersByBubbleId: {
            [X]: { bubbleId: X },
            [Y]: { bubbleId: Y },
          },
        }),
      ]),
    ),
    bubbles: Object.fromEntries(
      ids.map((id) => [
        id,
        [X, Y].map((bubbleId, i) => ({
          key: `bubbleId:${id}:${bubbleId}`,
          bubbleId,
          value: JSON.stringify({
            composerId: id,
            bubbleId,
            ...(i === 0 ? { nextBubbleId: Y } : { previousBubbleId: X }),
          }),
        })),
      ]),
    ),
  };
}

test('remap updates nested bubbleId values as well as object keys', async () => {
  const { cloned, composerMap, bubbleMap } =
    await cloneExportObjectForCopy(linkedPayload());

  const c = composerMap.get(A);
  const b = bubbleMap.get(`${A}\0${X}`);

  assert.ok(c);
  assert.ok(b);

  assert.equal(
    JSON.parse(cloned.composers[c]).fullConversationHeadersByBubbleId[b]
      .bubbleId,
    b,
  );
});

test('duplicate bubble IDs in different composers remain scoped', async () => {
  const { cloned, composerMap, bubbleMap } = await cloneExportObjectForCopy(
    linkedPayload([A, B]),
  );

  const firstId = composerMap.get(A);

  assert.ok(firstId);

  const first = JSON.parse(cloned.bubbles?.[firstId]?.[0].value || '{}') as {
    nextBubbleId: string;
  };

  assert.equal(first.nextBubbleId, bubbleMap.get(`${A}\0${Y}`));
});

test('previousBubbleId references the copied bubble', async () => {
  const { cloned, composerMap, bubbleMap } =
    await cloneExportObjectForCopy(linkedPayload());

  const cid = composerMap.get(A);

  assert.ok(cid);

  const second = JSON.parse(cloned.bubbles?.[cid]?.[1].value || '{}') as {
    previousBubbleId: string;
  };

  assert.equal(second.previousBubbleId, bubbleMap.get(`${A}\0${X}`));
});

test('unknown format versions are not accepted for mutation', () => {
  assert.throws(() =>
    assertExportShape({ ...linkedPayload(), formatVersion: 999 }),
  );
});
