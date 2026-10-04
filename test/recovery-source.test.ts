import test from 'node:test';
import assert from 'node:assert/strict';
import { RecoverySourceCheck } from '../src/recovery-source';

test('source recovery requires a known nonempty conversation and all ordered message bodies', () => {
  const check = new RecoverySourceCheck(
    'chat',
    { composerId: 'chat' },
    [
      { bubbleId: 'one', type: 1 },
      { bubbleId: 'two', type: 2 },
    ],
    true,
  );

  check.bubble('one', { type: 1 });
  assert.equal(check.candidate, false);
  check.bubble('two', { type: 2, composerId: 'chat', bubbleId: 'two' });
  assert.equal(check.candidate, true);
  assert.equal(new RecoverySourceCheck('chat', {}, [], true).candidate, false);
  assert.equal(new RecoverySourceCheck('chat', {}, [], false).candidate, false);
});

test('unknown roles, inconsistent identities and invalid message payloads fail source assessment', () => {
  for (const [fields, refs, payload] of [
    [{ composerId: 'other' }, [{ bubbleId: 'one', type: 1 }], { type: 1 }],
    [{}, [{ bubbleId: 'one', type: 3 }], { type: 3 }],
    [{}, [{ bubbleId: 'one', type: 1 }], { type: 2 }],
    [{}, [{ bubbleId: 'one', type: 1 }], { type: 1, composerId: 'other' }],
    [{}, [{ bubbleId: 'one', type: 1 }], { type: 1, bubbleId: 'other' }],
    [{}, [{ bubbleId: 'one', type: 1 }], 'invalid'],
    [{}, [null], { type: 1 }],
  ] as [Record<string, unknown>, unknown[], unknown][]) {
    const check = new RecoverySourceCheck('chat', fields, refs, true);

    check.bubble('one', payload);
    assert.equal(check.candidate, false);
  }
});
