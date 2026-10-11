import test from 'node:test';
import assert from 'node:assert/strict';
import { adjustFamilyPlan } from '../src/import-family-plan';
import type { Plan } from '../src/import-bundle-common';
import type { CatalogFamilyRow } from '../src/import-family-plan';

const parent = {
  composerId: 'parent',
  name: 'Parent',
  subagentComposerIds: ['child'],
};

const child = {
  composerId: 'child',
  name: 'Child',
  subagentInfo: { parentComposerId: 'parent' },
};

const orphan = {
  composerId: 'orphan',
  name: 'Orphan',
  subagentInfo: { parentComposerId: 'missing' },
};

const grand = {
  composerId: 'grand',
  name: 'Grand',
  subagentInfo: { parentComposerId: 'orphan' },
};

const kept = { composerId: 'kept', name: 'Kept' };

function row(
  sourceId: string,
  ordinal: number,
  decision: 'create' | 'skip',
  header: CatalogFamilyRow['header'],
): CatalogFamilyRow {
  return {
    sourceId,
    ordinal,
    name: header.name,
    decision,
    targetId: `dest-${sourceId}`,
    hash: `hash-${sourceId}`,
    header,
  };
}

test('family plan drop, promote, and an unchanged skip match one literal result', () => {
  const plan: Plan = {
    create: [1, 2, 3],
    skipped: [],
    already: [
      {
        composerId: 'parent',
        name: 'Parent',
        targetComposerId: 'dest-parent',
        reason: 'already imported',
      },
      {
        composerId: 'kept',
        name: 'Kept',
        targetComposerId: 'dest-kept',
        reason: 'already imported',
      },
    ],
    newVersions: [
      { composerId: 'child', name: 'Child', reason: 'updated version' },
      { composerId: 'grand', name: 'Grand', reason: 'updated version' },
    ],
    restored: [
      { composerId: 'orphan', name: 'Orphan', reason: 'restored copy' },
    ],
  };

  const adjusted = adjustFamilyPlan(
    [
      row('parent', 0, 'skip', parent),
      row('child', 1, 'create', child),
      row('orphan', 2, 'create', orphan),
      row('grand', 3, 'create', grand),
      row('kept', 4, 'skip', kept),
    ],
    plan,
    () => 'promoted-target',
  );

  assert.deepEqual(plan, {
    create: [1, 0],
    skipped: [
      {
        composerId: 'orphan',
        name: 'Orphan',
        reason: 'The parent chat is not in this archive.',
      },
      {
        composerId: 'grand',
        name: 'Grand',
        reason: 'The parent chat is not in this archive.',
      },
    ],
    already: [
      {
        composerId: 'kept',
        name: 'Kept',
        targetComposerId: 'dest-kept',
        reason: 'already imported',
      },
    ],
    newVersions: [
      { composerId: 'child', name: 'Child', reason: 'updated version' },
      {
        composerId: 'parent',
        name: 'Parent',
        reason: 'A subagent changed; a new conversation family will be created',
      },
    ],
    restored: [],
  });

  assert.deepEqual(adjusted.updates, [
    { sourceId: 'orphan', decision: 'skip', reason: 'missing-family' },
    { sourceId: 'grand', decision: 'skip', reason: 'missing-family' },
    {
      sourceId: 'parent',
      decision: 'create',
      reason: 'family-copy',
      targetId: 'promoted-target',
    },
  ]);

  assert.deepEqual(
    adjusted.skippedFamilies.map((item) => item.sourceId),
    ['kept'],
  );
});

test('a drop does not allocate an id', () => {
  const plan: Plan = {
    create: [2],
    skipped: [],
    already: [],
    newVersions: [],
    restored: [],
  };

  adjustFamilyPlan([row('orphan', 2, 'create', orphan)], plan, () => {
    throw new Error('speculative id');
  });

  assert.deepEqual(plan.create, []);
  assert.equal(plan.skipped[0]?.composerId, 'orphan');
});
