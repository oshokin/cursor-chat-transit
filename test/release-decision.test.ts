import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decide,
  skippedReleaseSummary,
  type ReleaseDecisionInput,
} from '../scripts/release-decision';

/** A push of an unchanged stable version on the default branch. */
function input(
  overrides: Partial<ReleaseDecisionInput> = {},
): ReleaseDecisionInput {
  return {
    event: 'push',
    ref: 'refs/heads/master',
    defaultBranch: 'master',
    publishRelease: false,
    shaVersion: '1.0.0',
    beforeAvailable: true,
    beforeVersion: '1.0.0',
    ...overrides,
  };
}

test('a pull request never publishes, even when the version changed', () => {
  assert.deepEqual(
    decide(input({ event: 'pull_request', shaVersion: '1.0.1' })),
    { publish: false },
  );
});

test('a push publishes only when the stable version increased', () => {
  assert.deepEqual(decide(input()), { publish: false });
  assert.deepEqual(decide(input({ shaVersion: '1.0.1' })), { publish: true });
  assert.throws(() => decide(input({ shaVersion: '0.9.0' })), /decreased/);

  assert.throws(
    () => decide(input({ shaVersion: '1.0.1-beta' })),
    /not stable/,
  );

  assert.throws(
    () => decide(input({ beforeAvailable: false, beforeVersion: null })),
    /Not guessing a bump/,
  );
});

test('a skipped release names the version, commit, and why nothing is published', () => {
  const same = skippedReleaseSummary({
    publish: false,
    event: 'push',
    shaVersion: '1.0.0',
    beforeVersion: '1.0.0',
    sha: 'abc123',
  });

  assert.match(same || '', /Version: `1\.0\.0`/);
  assert.match(same || '', /Commit: `abc123`/);
  assert.match(same || '', /Version unchanged — release not requested/);

  assert.match(
    skippedReleaseSummary({
      publish: false,
      event: 'pull_request',
      shaVersion: '1.0.1',
      beforeVersion: '1.0.0',
      sha: 'def',
    }) || '',
    /Pull request — release not requested/,
  );

  assert.equal(
    skippedReleaseSummary({
      publish: true,
      event: 'push',
      shaVersion: '1.0.1',
      beforeVersion: '1.0.0',
      sha: 'abc',
    }),
    null,
  );
});

test('manual publish runs only for the recorded version on the default branch', () => {
  assert.deepEqual(
    decide(input({ event: 'workflow_dispatch', publishRelease: false })),
    { publish: false },
  );

  assert.deepEqual(
    decide(input({ event: 'workflow_dispatch', publishRelease: true })),
    { publish: true },
  );

  assert.throws(
    () =>
      decide(
        input({
          event: 'workflow_dispatch',
          publishRelease: true,
          ref: 'refs/heads/feature',
        }),
      ),
    /default branch/,
  );
});
