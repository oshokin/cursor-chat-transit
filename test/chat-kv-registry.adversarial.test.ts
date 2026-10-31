import assert from 'node:assert/strict';
import test from 'node:test';
import {
  auxiliaryKeysFromJson,
  chatKvOwnedPatterns,
  classifyChatKvKey,
  parseChatKvJson,
  remapChatKvJson,
  remapChatKvKey,
} from '../src/chat-kv-registry';

test('renderer registry rejects ambiguous ownership keys', () => {
  assert.equal(classifyChatKvKey('composerDraft:chat:extra'), null);
  assert.equal(classifyChatKvKey('checkpointId:chat:'), null);
  assert.equal(classifyChatKvKey('checkpointId::value'), null);
  assert.equal(classifyChatKvKey('agentKv:unknown:value'), null);
  assert.equal(classifyChatKvKey('agentKv:checkpoint:'), null);
});

test('renderer key remapping changes only the composer segment', () => {
  const ids = new Map([['source', 'target']]);

  assert.equal(
    remapChatKvKey('codeBlockDiff:source:source:suffix', ids),
    'codeBlockDiff:target:source:suffix',
  );

  assert.equal(
    remapChatKvKey('agentKv:checkpoint:source', ids),
    'agentKv:checkpoint:target',
  );
});

test('renderer JSON remapping does not rewrite user strings', () => {
  const result = remapChatKvJson(
    {
      composerId: 'source',
      text: 'source',
      nested: {
        conversationId: 'source',
        artifactId: 'source',
        arbitraryId: 'source',
      },
    },
    new Map([['source', 'target']]),
    new Map([['source', 'aux-target']]),
  );

  assert.deepEqual(result, {
    composerId: 'target',
    text: 'source',
    nested: {
      conversationId: 'target',
      artifactId: 'aux-target',
      arbitraryId: 'source',
    },
  });
});

test('auxiliary traversal rejects wrong-family pointers', () => {
  assert.throws(
    () =>
      auxiliaryKeysFromJson({
        checkpointId: 'agentKv:artifact:not-a-checkpoint',
      }),
    /wrong family/,
  );
});

test('auxiliary traversal terminates across repeated shared objects', () => {
  const shared = { checkpointIds: ['one', 'two', 'one'] };
  const value = { left: shared, right: shared };

  assert.deepEqual([...auxiliaryKeysFromJson(value)], []);
});

test('graph records require object JSON', () => {
  assert.throws(
    () => parseChatKvJson(Buffer.from('"scalar"'), 'agentKv:checkpoint:x'),
    /not a JSON object/,
  );

  assert.throws(
    () => parseChatKvJson(Buffer.from('{'), 'agentKv:checkpoint:x'),
    /invalid JSON/,
  );
});

test('owned SQL patterns match Cursor composer blob-store keys', () => {
  assert.deepEqual(chatKvOwnedPatterns('chat'), {
    exact: [
      'composerDraft:chat',
      'composerConversationState:chat',
      'agentKv:checkpoint:chat',
    ],
    prefixes: [
      'checkpointId:chat:',
      'codeBlockDiff:chat:',
      'ofsContent:chat:',
      'agentKv:artifact:chat:',
      'agentKv:bubbleCheckpoint:chat:',
    ],
  });
});
