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
  /** Latest published stable version, without a `v` prefix. Null when nothing is published. */
  publishedVersion: string | null;
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

  if (!stableVersion(input.shaVersion)) {
    throw new Error(
      `Recorded version ${input.shaVersion} is not a stable X.Y.Z. Not publishing.`,
    );
  }

  if (input.publishedVersion === null) return { publish: true };

  if (!stableVersion(input.publishedVersion)) {
    throw new Error(
      `Published version ${input.publishedVersion} is not a stable X.Y.Z. Not guessing a release.`,
    );
  }

  if (semver.lt(input.shaVersion, input.publishedVersion)) {
    throw new Error(
      `Version decreased from ${input.publishedVersion} to ${input.shaVersion}. Not publishing.`,
    );
  }

  return { publish: semver.gt(input.shaVersion, input.publishedVersion) };
}

/** Read the latest published stable version. A 404 means nothing is published. */
export function publishedVersionFromLatest(
  status: number,
  body: string,
): string | null {
  if (status === 404) return null;

  if (status !== 200) {
    throw new Error(
      `GitHub API ${status} while reading the latest release. Not guessing a release.`,
    );
  }

  let parsed: { tag_name?: unknown };

  try {
    parsed = JSON.parse(body) as { tag_name?: unknown };
  } catch {
    throw new Error(
      'Latest release response is not JSON. Not guessing a release.',
    );
  }

  if (typeof parsed.tag_name !== 'string') {
    throw new Error('Latest release has no tag. Not guessing a release.');
  }

  const bare = parsed.tag_name.startsWith('v')
    ? parsed.tag_name.slice(1)
    : parsed.tag_name;

  if (!stableVersion(bare)) {
    throw new Error(
      `Published release ${parsed.tag_name} is not a stable vX.Y.Z. Not guessing a release.`,
    );
  }

  return bare;
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

/** Workflow summary when this run will not publish. */
export function skippedReleaseSummary(input: {
  /** True when the release job should run. */
  publish: boolean;
  /** GitHub event name. */
  event: string;
  /** package.json version on this commit. */
  shaVersion: string;
  /** Latest published stable version, when this run compared one. */
  publishedVersion: string | null;
  /** Commit that this workflow is building. */
  sha: string;
}): string | null {
  if (input.publish) return null;

  const matches =
    input.event === 'push' && input.publishedVersion === input.shaVersion;

  const reason = matches
    ? 'Published version matches package.json — release not requested.'
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

/** Latest published release, or null when GitHub has none. */
async function readPublishedVersion(): Promise<string | null> {
  const repository = process.env.GITHUB_REPOSITORY || '';
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';

  if (!repository || !token) {
    throw new Error(
      'GITHUB_REPOSITORY and GITHUB_TOKEN are required to read the published release. Not guessing a release.',
    );
  }

  const response = await fetch(
    `https://api.github.com/repos/${repository}/releases/latest`,
    {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'user-agent': 'cursor-chat-transit',
        'x-github-api-version': '2022-11-28',
      },
    },
  );

  return publishedVersionFromLatest(response.status, await response.text());
}

/** Decide from GitHub Actions environment variables. */
async function main(): Promise<void> {
  const event = process.env.GITHUB_EVENT_NAME || '';
  const ref = process.env.GITHUB_REF || '';
  const defaultBranch = process.env.DEFAULT_BRANCH || '';
  const publishRelease = process.env.PUBLISH_RELEASE === 'true';
  const shaVersion = versionAt('HEAD');

  const onDefault =
    Boolean(defaultBranch) && ref === `refs/heads/${defaultBranch}`;

  const published =
    event === 'push' && onDefault ? await readPublishedVersion() : null;

  const decision = decide({
    event,
    ref,
    defaultBranch,
    publishRelease,
    shaVersion,
    publishedVersion: published,
  });

  writeOutput(decision.publish);

  writeSummary(
    skippedReleaseSummary({
      publish: decision.publish,
      event,
      shaVersion,
      publishedVersion: published,
      sha: process.env.GITHUB_SHA || '',
    }),
  );
}

/** Absolute path of this file when it is the process entry point. */
const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';

if (entry.endsWith(`${path.sep}release-decision.ts`)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
