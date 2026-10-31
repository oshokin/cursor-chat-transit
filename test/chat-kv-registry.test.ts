import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHAT_KV_REGISTRY_VERSION,
  auxiliaryKeysFromJson,
  chatKvOwnedPatterns,
  classifyChatKvKey,
  remapChatKvJson,
  remapChatKvKey,
} from '../src/chat-kv-registry';
import { transformRendererKv } from '../src/import-bundle-resources';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

test('registry is typed, versioned, and classifies every portable family', () => {
  assert.equal(CHAT_KV_REGISTRY_VERSION, 1);

  const expected = new Map([
    [`composerDraft:${A}`, 'composerDraft'],
    [`composerConversationState:${A}`, 'composerConversationState'],
    [`checkpointId:${A}:x`, 'checkpointId'],
    [`codeBlockDiff:${A}:x`, 'codeBlockDiff'],
    [`ofsContent:${A}:x`, 'ofsContent'],
    [`agentKv:checkpoint:${A}`, 'checkpoint'],
    [`agentKv:artifact:${A}:artifact-id`, 'artifact'],
    [`agentKv:bubbleCheckpoint:${A}:bubble-id`, 'bubbleCheckpoint'],
  ]);

  for (const [key, family] of expected)
    assert.equal(classifyChatKvKey(key)?.family, family);

  for (const invalid of [
    '',
    `checkpointId:${A}`,
    `codeBlockDiff::x`,
    'agentKv:blob:x',
    'agentKv:checkpoint:',
    `composerDraft:${A}:extra`,
  ])
    assert.equal(classifyChatKvKey(invalid), null, invalid);
});

test('owned selectors cover exact sidecars and composer-keyed prefixes', () => {
  assert.deepEqual(chatKvOwnedPatterns(A), {
    exact: [
      `composerDraft:${A}`,
      `composerConversationState:${A}`,
      `agentKv:checkpoint:${A}`,
    ],
    prefixes: [
      `checkpointId:${A}:`,
      `codeBlockDiff:${A}:`,
      `ofsContent:${A}:`,
      `agentKv:artifact:${A}:`,
      `agentKv:bubbleCheckpoint:${A}:`,
    ],
  });
});

test('only the composer key segment is remapped', () => {
  const map = new Map([[A, B]]);

  assert.equal(
    remapChatKvKey(`checkpointId:${A}:keep-${A}`, map),
    `checkpointId:${B}:keep-${A}`,
  );

  assert.equal(
    remapChatKvKey(`agentKv:checkpoint:${A}`, map),
    `agentKv:checkpoint:${B}`,
  );

  assert.equal(
    remapChatKvKey(`agentKv:artifact:${A}:keep-${A}`, map),
    `agentKv:artifact:${B}:keep-${A}`,
  );
});

test('known JSON references remap while arbitrary text and unknown fields survive', () => {
  const value = {
    composerId: A,
    conversationId: A,
    prompt: `mention ${A}`,
    unknown: { text: A, future: 7 },
    nested: { checkpointId: 'cp', artifactIds: ['a'], bubbleCheckpoint: 'bc' },
  };

  assert.deepEqual(remapChatKvJson(value, new Map([[A, B]])), {
    composerId: B,
    conversationId: B,
    prompt: `mention ${A}`,
    unknown: { text: A, future: 7 },
    nested: { checkpointId: 'cp', artifactIds: ['a'], bubbleCheckpoint: 'bc' },
  });
});

test('auxiliary graph accepts known pointers and rejects cross-family pointers', () => {
  assert.deepEqual(
    [
      ...auxiliaryKeysFromJson({
        checkpointId: 'cp',
        nested: { artifactIds: ['a', `agentKv:artifact:${A}:b`] },
        bubbleCheckpoint: 'bc',
        arbitraryText: 'agentKv:checkpoint:not-an-edge',
      }),
    ].sort(),
    [`agentKv:artifact:${A}:b`],
  );

  assert.throws(() =>
    auxiliaryKeysFromJson({ artifactId: 'agentKv:checkpoint:wrong' }),
  );
});

test('import transforms JSON but preserves opaque bytes and SQLite class inputs', () => {
  const json = Buffer.from(
    JSON.stringify({
      composerId: A,
      text: A,
      unknown: { retained: true },
    }),
  );

  const transformed = transformRendererKv(
    `composerConversationState:${A}`,
    json,
    A,
    B,
  );

  assert.equal(transformed.key, `composerConversationState:${B}`);

  assert.deepEqual(JSON.parse(transformed.bytes.toString()), {
    composerId: B,
    text: A,
    unknown: { retained: true },
  });

  const opaque = Buffer.from([0, 255, 1, 2]);
  const leaf = transformRendererKv(`ofsContent:${A}:x`, opaque, A, B);

  assert.equal(leaf.key, `ofsContent:${B}:x`);
  assert.deepEqual(leaf.bytes, opaque);
});
