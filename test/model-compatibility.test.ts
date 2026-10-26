import test from 'node:test';
import assert from 'node:assert/strict';
import * as db from '../src/db';
import {
  APPLICATION_USER_STATE_KEY,
  readModelImportPolicy,
  resolveModelConfig,
  type ModelImportPolicy,
} from '../src/model-compatibility';
import type { SqliteConn } from '../src/types';

/** Minimal connection used only through the injected ItemTable reader. */
const conn = {} as SqliteConn;

/** Destination fallback used by pure policy tests. */
const policy: ModelImportPolicy = {
  availableModelIds: ['default', 'target-model'],
  fallback: {
    modelName: 'target-model',
    maxMode: false,
    selectedModels: [{ modelId: 'target-model', parameters: [] }],
  },
};

test('available archived model config is preserved exactly', () => {
  const source = {
    modelName: 'target-model',
    maxMode: true,
    selectedModels: [
      {
        modelId: 'target-model',
        parameters: [{ id: 'effort', value: 'high' }],
      },
    ],
    futureField: { kept: true },
  };

  assert.deepEqual(resolveModelConfig(source, policy), {
    config: source,
    replaced: false,
  });
});

test('unavailable or malformed config falls back without carrying unknown data', () => {
  const unavailable = resolveModelConfig(
    {
      modelName: 'source-custom',
      maxMode: true,
      selectedModels: [
        {
          modelId: 'source-custom',
          parameters: [{ id: 'fast', value: true }],
        },
      ],
    },
    policy,
  );

  assert.equal(unavailable.replaced, true);
  assert.equal(unavailable.sourceModel, 'source-custom');
  assert.equal(unavailable.fallbackModel, 'target-model');
  assert.deepEqual(unavailable.config, policy.fallback);

  assert.equal(
    resolveModelConfig({ secret: 'not-a-model' }, policy).replaced,
    true,
  );
});

test('BYOK and built-in model capabilities are additive', async (t) => {
  const state = {
    useOpenAIKey: true,
    openAIBaseUrl: 'https://private.invalid',
    availableDefaultModels2: [{ serverModelName: 'built-in', defaultOn: true }],
    availableAPIKeyModels: ['declared-api-model'],
    aiSettings: {
      userAddedModels: ['target-custom'],
      modelOverrideEnabled: ['enabled-custom'],
      modelConfig: {
        composer: {
          modelName: 'target-custom',
          maxMode: false,
          selectedModels: [{ modelId: 'target-custom', parameters: [] }],
        },
      },
    },
  };

  t.after(() => {
    db.testHooks.readItemText = undefined;
  });

  db.testHooks.readItemText = async (_conn, key) => {
    assert.equal(key, APPLICATION_USER_STATE_KEY);

    return JSON.stringify(state);
  };

  const actual = await readModelImportPolicy(conn);

  assert.deepEqual(actual.availableModelIds, [
    'built-in',
    'declared-api-model',
    'default',
    'enabled-custom',
    'target-custom',
  ]);

  assert.equal(JSON.stringify(actual).includes('private.invalid'), false);

  assert.equal(
    resolveModelConfig(
      { modelName: 'built-in', selectedModels: [{ modelId: 'built-in' }] },
      actual,
    ).replaced,
    false,
  );
});

test('OpenAI BYOK does not hide an enabled built-in Grok model', async (t) => {
  const state = {
    useOpenAIKey: true,
    availableDefaultModels2: [
      { serverModelName: 'grok-4.6', defaultOn: true },
      { serverModelName: 'gpt-5.3-codex', defaultOn: false },
    ],
    availableAPIKeyModels: [],
    aiSettings: {
      userAddedModels: ['gpt-5.6-sol-medium'],
      modelOverrideEnabled: ['gpt-5.6-sol-medium'],
      modelConfig: {
        composer: {
          modelName: 'gpt-5.6-sol-medium',
          maxMode: false,
          selectedModels: [{ modelId: 'gpt-5.6-sol-medium', parameters: [] }],
        },
      },
    },
  };

  t.after(() => {
    db.testHooks.readItemText = undefined;
  });

  db.testHooks.readItemText = async () => JSON.stringify(state);
  const actual = await readModelImportPolicy(conn);

  assert.equal(actual.availableModelIds.includes('grok-4.6'), true);
  assert.equal(actual.availableModelIds.includes('gpt-5.3-codex'), false);

  assert.equal(
    resolveModelConfig(
      {
        modelName: 'grok-4.6',
        selectedModels: [{ modelId: 'grok-4.6', parameters: [] }],
      },
      actual,
    ).replaced,
    false,
  );
});

test('missing or damaged profile state safely uses Cursor default', async (t) => {
  t.after(() => {
    db.testHooks.readItemText = undefined;
  });

  for (const raw of [null, '', '{broken']) {
    db.testHooks.readItemText = async () => raw;
    const actual = await readModelImportPolicy(conn);

    assert.deepEqual(actual.availableModelIds, ['default']);
    assert.equal(actual.fallback.modelName, 'default');
  }

  db.testHooks.readItemText = async () => {
    throw new Error('profile unavailable');
  };

  assert.equal(
    (await readModelImportPolicy(conn)).fallback.modelName,
    'default',
  );
});
