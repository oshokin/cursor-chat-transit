import test from 'node:test';
import assert from 'node:assert/strict';
import { planRecovery } from '../src/recovery';

/** Chat that can be imported complete. */
const complete = { status: 'complete' as const, composerId: 'a' };
/** Chat that is missing blobs and images but still has history. */
const partial = {
  status: 'missing-dependencies' as const,
  composerId: 'b',
  missingBlobs: 2,
  missingImages: 1,
  missingPlans: 0,
};
/** Chat that cannot be recovered even with allowPartial. */
const bad = {
  status: 'unusable-chat' as const,
  composerId: 'c',
  reason: 'malformed bubble',
};

test('strict default rejects incomplete batches', () => {
  assert.throws(
    () => planRecovery([complete, partial], false),
    /INCOMPLETE_IMPORT/,
  );
});

test('recovery keeps valid chats and reports history-only and skipped separately', () => {
  assert.deepEqual(planRecovery([complete, partial, bad], true), {
    complete: ['a'],
    historyOnly: ['b'],
    skipped: [{ composerId: 'c', reason: 'malformed bubble' }],
  });
});

test('a wholly unusable file is not a successful zero-chat import', () => {
  assert.throws(() => planRecovery([bad], true), /NOTHING_TO_IMPORT/);
});
