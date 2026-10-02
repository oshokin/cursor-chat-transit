import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chatStatistics,
  userMessageCount,
  workspaceCounts,
} from '../src/statistics';

test('titled and untitled are distinct counts, not estimates of chat usefulness', () => {
  assert.equal(
    workspaceCounts([
      { composerId: 'a', name: 'Title' },
      { composerId: 'b', name: '' },
      { composerId: 'c', name: '  ' },
      { composerId: 'd' },
      { composerId: 'e', name: 'Untitled chat' },
    ]),
    '2 titled · 3 untitled',
  );

  assert.equal(workspaceCounts([]), '0 titled · 0 untitled');
});

test('user message counts deduplicate references and never count assistant/tool bubbles', () => {
  assert.equal(
    userMessageCount({
      fullConversationHeadersOnly: [
        { bubbleId: 'a', type: 1 },
        { bubbleId: 'a', type: 1 },
        { bubbleId: 'b', type: 2 },
        { bubbleId: 'c', type: 1 },
      ],
    }),
    2,
  );

  assert.equal(
    userMessageCount({
      conversation: [
        { role: 'user' },
        { role: 'assistant' },
        { role: 'tool' },
        { role: 'system' },
      ],
    }),
    1,
  );

  assert.equal(userMessageCount({ fullConversationHeadersOnly: [] }), 0);
  assert.equal(userMessageCount({}), undefined);

  assert.equal(
    userMessageCount({ fullConversationHeadersOnly: [{ type: 99 }] }),
    undefined,
  );

  assert.equal(
    userMessageCount({
      fullConversationHeadersOnly: [
        { bubbleId: 'a', type: 1 },
        { bubbleId: 'a', type: 2 },
      ],
    }),
    undefined,
  );
});

test('format follows explicit isNAL, never document version or nonempty state alone', () => {
  assert.match(
    chatStatistics({
      _v: 17,
      isNAL: false,
      conversationState: '~',
      fullConversationHeadersOnly: [{ type: 1 }],
    }),
    /^1 user message · Legacy format — may not continue$/,
  );

  assert.match(
    chatStatistics({
      _v: 17,
      isNAL: true,
      fullConversationHeadersOnly: [{ type: 1 }, { type: 1 }],
    }),
    /^2 user messages · Agent format$/,
  );

  assert.equal(
    chatStatistics({ _v: 17, conversationState: '~abc' }),
    'Message count unavailable · Format unknown',
  );

  assert.doesNotMatch(
    chatStatistics({ isNAL: true }),
    /can continue|compatible/i,
  );
});
