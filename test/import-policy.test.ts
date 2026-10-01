import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalJson,
  classifyTargetObservation,
  snapshotFingerprint,
  snapshotInputFromChat,
  decideImport,
  type SnapshotInput,
  type Receipt,
} from '../src/import-policy';
import { encodePlan } from '../src/plans';

/** Minimal complete snapshot used as the baseline for fingerprint tests. */
function fixture(): SnapshotInput {
  return {
    sourceComposerId: 'source',
    header: { name: 'Original', lastUpdatedAt: 7 },
    body: {
      composerId: 'source',
      fullConversationHeadersOnly: [{ bubbleId: 'a' }, { bubbleId: 'b' }],
    },
    bubbles: [
      { bubbleId: 'a', payload: { text: 'one' } },
      { bubbleId: 'b', payload: { text: 'two' } },
    ],
    dependencies: [],
    quality: 'complete',
  };
}

/** Target key and source identity shared by receipt fixtures. */
const request = {
  targetKey: 'target',
  sourceComposerId: 'source',
  snapshotHash: 'hash',
};

/** Verified receipt that matches `request`. */
const receipt: Receipt = {
  ...request,
  targetComposerId: 'copy',
  state: 'verified',
};

test('object key order does not matter; array order does', () => {
  assert.equal(canonicalJson({ b: 2, a: 1 }), canonicalJson({ a: 1, b: 2 }));
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
});

test('row enumeration order does not change snapshot', () => {
  const a = fixture();
  const b = fixture();

  b.bubbles.reverse();
  assert.equal(snapshotFingerprint(a), snapshotFingerprint(b));
});

test('title, message text and ordered conversation change snapshot', () => {
  const a = fixture();

  for (const mutate of [
    (b: SnapshotInput) => {
      b.header.name = 'Renamed';
    },
    (b: SnapshotInput) => {
      b.bubbles[0]!.payload.text = 'New';
    },
    (b: SnapshotInput) => {
      (b.body.fullConversationHeadersOnly as unknown[]).reverse();
    },
  ]) {
    const b = fixture();

    mutate(b);
    assert.notEqual(snapshotFingerprint(a), snapshotFingerprint(b));
  }
});

test('textPreview inside a message payload changes the snapshot', () => {
  const left = fixture();
  const right = fixture();

  left.bubbles[0]!.payload = {
    toolResult: { grouping: { textPreview: 'actual-data-A' } },
  };

  right.bubbles[0]!.payload = {
    toolResult: { grouping: { textPreview: 'actual-data-B' } },
  };

  assert.notEqual(snapshotFingerprint(left), snapshotFingerprint(right));
});

test('grouping.textPreview alone does not change the snapshot', () => {
  const withPreview = fixture();
  const withoutPreview = fixture();

  const headers = withPreview.body.fullConversationHeadersOnly as Array<
    Record<string, unknown>
  >;

  headers[0] = {
    bubbleId: 'a',
    grouping: { textPreview: 'stale preview' },
  };

  assert.equal(
    snapshotFingerprint(withPreview),
    snapshotFingerprint(withoutPreview),
  );
});

test('workspace rebinding alone does not change source snapshot', () => {
  const a = fixture();
  const b = fixture();

  b.header.workspaceIdentifier = { id: 'other' };
  assert.equal(snapshotFingerprint(a), snapshotFingerprint(b));
});

test('missing dependency becoming available changes snapshot', () => {
  const a = fixture();
  const b = fixture();

  a.quality = 'history-only';
  a.dependencies = [{ kind: 'kv', id: 'blob', sha256: null }];

  b.dependencies = [
    {
      kind: 'kv',
      id: 'blob',
      sha256: 'f'.repeat(64),
      storageClass: 'blob',
      byteLength: 1,
    },
  ];

  assert.notEqual(snapshotFingerprint(a), snapshotFingerprint(b));
});

test('same imported source is skipped even if user continued its target copy', async () => {
  assert.deepEqual(
    await decideImport(request, [receipt], async () => 'available'),
    {
      action: 'skip',
      targetComposerId: 'copy',
    },
  );
});

test('changed source is another snapshot, never an overwrite', async () => {
  assert.deepEqual(
    await decideImport(
      { ...request, snapshotHash: 'new' },
      [receipt],
      async () => 'available',
    ),
    { action: 'create', reason: 'different-snapshot' },
  );
});

test('deleted copy may be restored, inconsistent copy is blocked', async () => {
  assert.deepEqual(
    await decideImport(request, [receipt], async () => 'deleted'),
    {
      action: 'create',
      reason: 'deleted-copy',
    },
  );

  assert.deepEqual(
    await decideImport(request, [receipt], async () => 'inconsistent'),
    { action: 'blocked', reason: 'inconsistent-target' },
  );

  assert.deepEqual(
    await decideImport(request, [receipt], async () => 'detached'),
    { action: 'create', reason: 'deleted-copy' },
  );
});

test('an available copy wins over a stale inconsistent mapping of the same snapshot', async () => {
  const stale: Receipt = { ...receipt, targetComposerId: 'stale' };
  const live: Receipt = { ...receipt, targetComposerId: 'live' };

  const probe = async (id: string) =>
    id === 'live' ? ('available' as const) : ('inconsistent' as const);

  for (const receipts of [
    [stale, live],
    [live, stale],
  ]) {
    assert.deepEqual(await decideImport(request, receipts, probe), {
      action: 'skip',
      targetComposerId: 'live',
    });
  }
});

test('classifyTargetObservation treats leftover rows without a workspace list as detached', () => {
  const facts = {
    body: 'present' as const,
    bubbles: 2,
    workspaceList: 'absent' as const,
    workspaceHeaders: 'absent' as const,
    workspaceSelected: 'absent' as const,
    globalHeader: 'present' as const,
    globalHeadersTable: 'absent' as const,
    globalWorkspaceBinding: 'absent' as const,
    archived: 'absent' as const,
    bodyShape: 'valid' as const,
    references: 'satisfied' as const,
    metadata: 'ok' as const,
  };

  assert.equal(classifyTargetObservation(facts), 'detached');

  assert.equal(
    classifyTargetObservation({
      ...facts,
      body: 'absent',
      bodyShape: 'absent',
      bubbles: 0,
    }),
    'detached',
  );

  assert.equal(
    classifyTargetObservation({
      ...facts,
      body: 'absent',
      bodyShape: 'absent',
      bubbles: 0,
      globalHeader: 'absent',
    }),
    'deleted',
  );

  assert.equal(
    classifyTargetObservation({
      ...facts,
      workspaceList: 'present',
    }),
    'available',
  );

  assert.equal(
    classifyTargetObservation({
      ...facts,
      body: 'absent',
      bodyShape: 'absent',
      workspaceList: 'present',
    }),
    'inconsistent',
  );

  assert.equal(
    classifyTargetObservation({
      ...facts,
      archived: 'present',
    }),
    'available',
  );

  assert.equal(
    classifyTargetObservation({
      ...facts,
      body: 'absent',
      bodyShape: 'absent',
      bubbles: 0,
      globalHeader: 'absent',
      globalHeadersTable: 'present',
      archived: 'present',
    }),
    'detached',
  );

  assert.equal(
    classifyTargetObservation({
      ...facts,
      globalHeader: 'absent',
      globalWorkspaceBinding: 'present',
    }),
    'available',
  );

  assert.equal(
    classifyTargetObservation({
      ...facts,
      globalWorkspaceBinding: 'conflict',
    }),
    'inconsistent',
  );

  assert.equal(
    classifyTargetObservation({
      ...facts,
      bodyShape: 'invalid',
    }),
    'inconsistent',
  );

  assert.equal(
    classifyTargetObservation({
      ...facts,
      references: 'missing',
    }),
    'inconsistent',
  );

  assert.equal(
    classifyTargetObservation({
      ...facts,
      metadata: 'invalid',
    }),
    'inconsistent',
  );
});

test('different target workspace imports independently', async () => {
  assert.deepEqual(
    await decideImport(
      { ...request, targetKey: 'other' },
      [receipt],
      async () => 'available',
    ),
    { action: 'create', reason: 'first-import' },
  );
});

test('unfinished target operation blocks a new mapping', async () => {
  assert.deepEqual(
    await decideImport(
      request,
      [{ ...receipt, state: 'pending' }],
      async () => 'available',
    ),
    { action: 'blocked', reason: 'pending-import' },
  );
});

test('duplicate record identities are rejected', () => {
  const a = fixture();

  a.bubbles.push(a.bubbles[0]!);
  assert.throws(() => snapshotFingerprint(a), /Duplicate/);
});

test('reachable plan files are part of the snapshot fingerprint', () => {
  const name = 'hello_world_9740ba02.plan.md';

  const bodyText = JSON.stringify({
    composerId: 'source',
    planUri: `file:///tmp/${name}`,
  });

  const header = { composerId: 'source' };

  const first = snapshotInputFromChat({
    header,
    bodyText,
    bubbles: [],
    resources: {
      kv: [],
      attachments: [],
      plans: [encodePlan(name, Buffer.from('one'))],
    },
    quality: 'complete',
  });

  const second = snapshotInputFromChat({
    header,
    bodyText,
    bubbles: [],
    resources: {
      kv: [],
      attachments: [],
      plans: [encodePlan(name, Buffer.from('two'))],
    },
    quality: 'complete',
  });

  const missing = snapshotInputFromChat({
    header,
    bodyText,
    bubbles: [],
    resources: { kv: [], attachments: [], plans: [] },
    quality: 'history-only',
  });

  assert.ok(first.dependencies.some((row) => row.kind === 'plan'));
  assert.notEqual(snapshotFingerprint(first), snapshotFingerprint(second));
  assert.notEqual(snapshotFingerprint(first), snapshotFingerprint(missing));
});
