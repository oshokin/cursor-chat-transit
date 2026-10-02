import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decide,
  publishedVersionFromLatest,
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
    publishedVersion: '1.0.0',
    ...overrides,
  };
}

test('a pull request never publishes, even when the version changed', () => {
  assert.deepEqual(
    decide(input({ event: 'pull_request', shaVersion: '1.0.1' })),
    { publish: false },
  );
});

test('a push publishes when nothing is published or the published version is older', () => {
  assert.deepEqual(decide(input()), { publish: false });

  assert.deepEqual(decide(input({ publishedVersion: null })), {
    publish: true,
  });

  assert.deepEqual(decide(input({ shaVersion: '1.0.1' })), { publish: true });
  assert.throws(() => decide(input({ shaVersion: '0.9.0' })), /decreased/);

  assert.throws(
    () => decide(input({ shaVersion: '1.0.1-beta', publishedVersion: null })),
    /Not publishing/,
  );
});

test('the latest published release is its stable tag, and a missing release is empty', () => {
  assert.equal(
    publishedVersionFromLatest(200, JSON.stringify({ tag_name: 'v1.0.0' })),
    '1.0.0',
  );

  assert.equal(publishedVersionFromLatest(404, ''), null);

  assert.throws(
    () => publishedVersionFromLatest(500, ''),
    /Not guessing a release/,
  );

  assert.throws(
    () =>
      publishedVersionFromLatest(
        200,
        JSON.stringify({ tag_name: 'v1.0.0-beta' }),
      ),
    /not a stable/,
  );
});

test('a skipped release names the version, commit, and why nothing is published', () => {
  const same = skippedReleaseSummary({
    publish: false,
    event: 'push',
    shaVersion: '1.0.0',
    publishedVersion: '1.0.0',
    sha: 'abc123',
  });

  assert.match(same || '', /Version: `1\.0\.0`/);
  assert.match(same || '', /Commit: `abc123`/);

  assert.match(
    same || '',
    /Published version matches package.json — release not requested/,
  );

  assert.match(
    skippedReleaseSummary({
      publish: false,
      event: 'pull_request',
      shaVersion: '1.0.1',
      publishedVersion: null,
      sha: 'def',
    }) || '',
    /Pull request — release not requested/,
  );

  assert.equal(
    skippedReleaseSummary({
      publish: true,
      event: 'push',
      shaVersion: '1.0.0',
      publishedVersion: null,
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
