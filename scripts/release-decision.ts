import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import semver from 'semver';
import { stableVersion } from './stable-version';

/** Facts the workflow knows before it asks whether to publish. */
export interface ReleaseDecisionInput {
  /** GitHub event that started the workflow. */
  event: string;
  /** Full ref of the event, such as `refs/heads/master`. */
  ref: string;
  /** Repository default branch name, without `refs/heads/`. */
  defaultBranch: string;
  /** workflow_dispatch input. Ignored for other events. */
  publishRelease: boolean;
  /** package.json version at the event SHA. */
  shaVersion: string;
  /** False when the previous branch tip cannot be read. */
  beforeAvailable: boolean;
  /** package.json version at `github.event.before`, when it could be read. */
  beforeVersion: string | null;
}

/** Result consumed by the release job. */
export interface ReleaseDecision {
  /** True when this SHA should get a tag and a GitHub Release. */
  publish: boolean;
}

/** Whether this event should create the GitHub Release for the recorded version. */
export function decide(input: ReleaseDecisionInput): ReleaseDecision {
  if (!input.defaultBranch) {
    throw new Error('Default branch is unknown. Not guessing a release.');
  }

  const onDefault = input.ref === `refs/heads/${input.defaultBranch}`;

  if (input.event === 'pull_request') return { publish: false };

  if (input.event === 'workflow_dispatch') {
    if (!input.publishRelease) return { publish: false };

    if (!onDefault) {
      throw new Error(
        'publish_release is only allowed on the default branch. Not publishing a feature branch.',
      );
    }

    if (!stableVersion(input.shaVersion)) {
      throw new Error(
        `Recorded version ${input.shaVersion} is not a stable X.Y.Z. Not publishing.`,
      );
    }

    return { publish: true };
  }

  if (input.event !== 'push') return { publish: false };
  if (!onDefault) return { publish: false };

  if (!input.beforeAvailable || !input.beforeVersion) {
    throw new Error(
      'Cannot compare package versions with the previous branch tip. Not guessing a bump.',
    );
  }

  if (!stableVersion(input.beforeVersion) || !stableVersion(input.shaVersion)) {
    throw new Error(
      `Cannot publish because a version is not stable X.Y.Z (${input.beforeVersion} -> ${input.shaVersion}).`,
    );
  }

  if (semver.lt(input.shaVersion, input.beforeVersion)) {
    throw new Error(
      `Version decreased from ${input.beforeVersion} to ${input.shaVersion}. Not publishing.`,
    );
  }

  return { publish: semver.gt(input.shaVersion, input.beforeVersion) };
}

/** Read `package.json` version from a commit that is already in this clone. */
function versionAt(rev: string): string {
  const result = spawnSync('git', ['show', `${rev}:package.json`], {
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    throw new Error(
      `Cannot read package.json at ${rev}. Not guessing a bump.\n${(result.stderr || '').trim()}`,
    );
  }

  const version = (JSON.parse(result.stdout) as { version?: unknown }).version;

  if (typeof version !== 'string') {
    throw new Error(`package.json at ${rev} has no version string.`);
  }

  return version;
}

/** Read the previous tip, fetching that one commit when the clone does not have it. */
function beforeVersion(rev: string): string {
  try {
    return versionAt(rev);
  } catch (error) {
    const fetched = spawnSync('git', ['fetch', '--no-tags', 'origin', rev], {
      encoding: 'utf8',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });

    if (fetched.status !== 0) {
      const reason = error instanceof Error ? error.message : String(error);

      throw new Error(
        `${reason}\nCould not fetch ${rev} from origin. Not guessing a bump.\n${(fetched.stderr || '').trim()}`,
        { cause: error },
      );
    }

    return versionAt(rev);
  }
}

/** Workflow summary when this run will not publish. */
export function skippedReleaseSummary(input: {
  /** True when the release job should run. */
  publish: boolean;
  /** GitHub event name. */
  event: string;
  /** package.json version on this commit. */
  shaVersion: string;
  /** package.json version on the previous tip, when known. */
  beforeVersion: string | null;
  /** Commit that this workflow is building. */
  sha: string;
}): string | null {
  if (input.publish) return null;

  const unchanged =
    input.event === 'push' &&
    input.beforeVersion !== null &&
    input.shaVersion === input.beforeVersion;

  const reason = unchanged
    ? 'Version unchanged — release not requested.'
    : input.event === 'pull_request'
      ? 'Pull request — release not requested.'
      : 'Release not requested.';

  return [
    '### Release',
    '',
    `- Version: \`${input.shaVersion}\``,
    `- Commit: \`${input.sha}\``,
    `- ${reason}`,
    '',
  ].join('\n');
}

/** Append markdown to the Actions job summary when that file is configured. */
function writeSummary(markdown: string | null): void {
  const file = process.env.GITHUB_STEP_SUMMARY;

  if (!markdown || !file) return;
  fs.appendFileSync(file, markdown);
}

/** Write `publish=true|false` for the workflow job output. */
function writeOutput(publish: boolean): void {
  const line = `publish=${publish ? 'true' : 'false'}\n`;
  const file = process.env.GITHUB_OUTPUT;

  if (file) fs.appendFileSync(file, line);
  else process.stdout.write(line);
}

/** Decide from GitHub Actions environment variables. */
function main(): void {
  const event = process.env.GITHUB_EVENT_NAME || '';
  const ref = process.env.GITHUB_REF || '';
  const defaultBranch = process.env.DEFAULT_BRANCH || '';
  const publishRelease = process.env.PUBLISH_RELEASE === 'true';
  const shaVersion = versionAt('HEAD');
  const before = process.env.BEFORE || '';
  const zero = '0000000000000000000000000000000000000000';
  let available = false;
  let previous: string | null = null;

  if (event === 'push' && before && before !== zero) {
    previous = beforeVersion(before);
    available = true;
  }

  const decision = decide({
    event,
    ref,
    defaultBranch,
    publishRelease,
    shaVersion,
    beforeAvailable: available,
    beforeVersion: previous,
  });

  writeOutput(decision.publish);

  writeSummary(
    skippedReleaseSummary({
      publish: decision.publish,
      event,
      shaVersion,
      beforeVersion: previous,
      sha: process.env.GITHUB_SHA || '',
    }),
  );
}

/** Absolute path of this file when it is the process entry point. */
const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';

if (entry.endsWith(`${path.sep}release-decision.ts`)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
