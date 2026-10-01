import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import semver from 'semver';
import { stableVersion } from './stable-version';

/** How to run release-it: show the plan, or write the version files. */
type Mode = 'preview' | 'prepare';

/** Stable tag release-it and this guard both treat as the previous release. */
interface ReleaseBaseline {
  /** Tag name, including the `v` prefix. */
  tag: string;
  /** `X.Y.Z` stored in that tag. */
  version: string;
}

/** Arguments after the script name. */
interface PrepareCommand {
  /** Show the plan, or write the version files. */
  mode: Mode;
  /** `patch`, `minor`, `major`, or an explicit `X.Y.Z`, when the caller passed one. */
  increment?: string;
}

/** Tag patterns release-it passes to `git describe`. */
interface TagPolicy {
  /** Glob passed as `--match`. It is not a SemVer check. */
  match: string;
  /** Glob passed as `--exclude`, when configured. */
  exclude?: string;
}

/** Stop the command and keep any version-file diff for inspection. */
function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** Run git and return trimmed stdout, or throw the git error text. */
function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });

  if (result.error) throw result.error;

  if (result.status !== 0) {
    throw new Error(
      (result.stderr || result.stdout || `git ${args.join(' ')} failed`).trim(),
    );
  }

  return result.stdout.trim();
}

/** Refuse when the worktree or the index has anything uncommitted. */
function requireClean(cwd: string): void {
  const status = git(cwd, ['status', '--porcelain']);

  if (status) {
    fail(
      `Working tree or index is not clean. Commit or remove those changes before preparing a version.\n${status}`,
    );
  }
}

/** Update local tags from origin. A failed fetch is not an empty tag list. */
function fetchTags(cwd: string): void {
  let remotes = '';

  try {
    remotes = git(cwd, ['remote']);
  } catch (error) {
    fail(
      error instanceof Error ? error.message : 'Could not list git remotes.',
    );
  }

  if (!remotes.split('\n').includes('origin')) {
    fail(
      'No origin remote. Refusing to prepare a version without tags from origin.',
    );
  }

  const result = spawnSync(
    'git',
    ['fetch', 'origin', 'refs/tags/*:refs/tags/*'],
    {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    },
  );

  if (result.status !== 0) {
    fail(
      `Could not fetch tags from origin. Not assuming that no tags exist.\n${(result.stderr || result.stdout || '').trim()}`,
    );
  }
}

/** Read the tag globs release-it will use for the same baseline. */
function tagPolicy(cwd: string): TagPolicy {
  const file = path.join(cwd, '.release-it.json');

  const config = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    git?: { tagMatch?: unknown; tagExclude?: unknown };
  };

  const match = config.git?.tagMatch;
  const exclude = config.git?.tagExclude;

  if (typeof match !== 'string' || !match) {
    fail('.release-it.json git.tagMatch is missing.');
  }

  return {
    match,
    exclude: typeof exclude === 'string' && exclude ? exclude : undefined,
  };
}

/**
 * Closest stable release tag reachable from HEAD.
 * Uses the same describe globs as release-it, then rejects a non-SemVer match.
 */
function baseline(cwd: string, policy: TagPolicy): ReleaseBaseline | null {
  const args = ['describe', '--tags', '--abbrev=0', '--match', policy.match];

  if (policy.exclude) args.push('--exclude', policy.exclude);
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });

  if (result.status !== 0) return null;
  const tag = result.stdout.trim();
  const version = tag.startsWith('v') ? tag.slice(1) : tag;

  if (!stableVersion(version)) {
    fail(
      `Tag ${tag} is the closest release-tag match, but it is not a stable X.Y.Z version. Refusing to guess another baseline.`,
    );
  }

  return { tag, version };
}

/** package.json version. It must already be stable. */
function packageVersion(cwd: string): string {
  const version = (
    JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')) as {
      version?: unknown;
    }
  ).version;

  if (typeof version !== 'string' || !stableVersion(version)) {
    fail(`package.json version ${String(version)} is not a stable X.Y.Z.`);
  }

  return version;
}

/** Both lockfile version fields must equal the package version. */
function assertLock(cwd: string, version: string): void {
  const lock = JSON.parse(
    fs.readFileSync(path.join(cwd, 'package-lock.json'), 'utf8'),
  ) as { version?: unknown; packages?: { ''?: { version?: unknown } } };

  const top = lock.version;
  const root = lock.packages?.['']?.version;

  if (top !== version || root !== version) {
    fail(
      `package-lock.json versions (${String(top)}, ${String(root)}) do not both equal ${version}.`,
    );
  }
}

/** Drop unexpected staging. Working-tree edits stay in place. */
function unstage(cwd: string): void {
  let listed = '';

  try {
    listed = git(cwd, ['diff', '--cached', '--name-only']);
  } catch (error) {
    fail(
      error instanceof Error ? error.message : 'Could not inspect the index.',
    );
  }

  const paths = listed.split('\n').filter(Boolean);

  if (!paths.length) return;

  const result = spawnSync('git', ['restore', '--staged', '--', ...paths], {
    cwd,
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    fail(
      `Could not unstage ${paths.join(', ')}. Working-tree changes were kept.\n${(result.stderr || '').trim()}`,
    );
  }
}

/** Run the pinned release-it binary. Arguments are an array, not a shell line. */
function runReleaseIt(cwd: string, mode: Mode, increment?: string): number {
  const bin = path.join(
    cwd,
    'node_modules',
    'release-it',
    'bin',
    'release-it.js',
  );

  if (!fs.existsSync(bin)) {
    fail(`release-it is not installed at ${bin}.`);
  }

  const args = [bin, '--ci'];

  if (mode === 'preview') args.push('--dry-run');
  if (increment) args.push(increment);
  const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8' });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;

  return result.status ?? 1;
}

/** `preview` or `prepare`, plus an optional patch, minor, major, or X.Y.Z. */
function parseArgs(argv: string[]): PrepareCommand {
  const [mode, increment, extra] = argv;

  if ((mode !== 'preview' && mode !== 'prepare') || extra) {
    fail('Usage: prepare-release.ts preview|prepare [patch|minor|major|X.Y.Z]');
  }

  if (!increment) return { mode };

  if (
    increment === 'patch' ||
    increment === 'minor' ||
    increment === 'major' ||
    stableVersion(increment)
  ) {
    return { mode, increment };
  }

  fail(
    `Unsupported bump "${increment}". Use patch, minor, major, or a stable X.Y.Z version.`,
  );
}

/** Prepare or preview one version. Does not commit, tag, push, or publish. */
function main(): void {
  const cwd = process.cwd();
  const { mode, increment } = parseArgs(process.argv.slice(2));

  requireClean(cwd);
  fetchTags(cwd);
  const current = packageVersion(cwd);
  const base = baseline(cwd, tagPolicy(cwd));

  if (!base) {
    fail(
      `No stable release tag is reachable from HEAD. package.json is ${current} and has not been published as a tag. Publish that recorded version before preparing another one. Not creating a baseline tag.`,
    );
  }

  if (semver.neq(current, base.version)) {
    if (semver.gt(current, base.version)) {
      fail(
        `Version ${current} is already prepared above ${base.tag}. Not bumping again. Publish it, or revert this unpublished prepare and run prepare once with the bump you want.`,
      );
    }

    fail(
      `package.json version ${current} is behind release tag ${base.tag}. Not guessing a bump.`,
    );
  }

  if (mode === 'preview') {
    console.log(
      `Current version ${current} at ${base.tag}. Preview only; files will not be written.`,
    );
  }

  const status = runReleaseIt(cwd, mode, increment);

  unstage(cwd);
  if (status !== 0) process.exit(status);
  const dirty = git(cwd, ['status', '--porcelain']);
  const next = packageVersion(cwd);

  if (mode === 'preview') {
    if (dirty || next !== current) {
      fail(
        'Preview changed the working tree. Those edits were left in place and were not staged.',
      );
    }

    return;
  }

  if (next === current) {
    if (dirty) {
      fail(
        'release-it left file changes without changing the version. Inspect the diff. Nothing was staged.',
      );
    }

    console.log(
      `No releasable changes since ${base.tag}. Version stays ${current}.`,
    );

    return;
  }

  assertLock(cwd, next);
  const names = git(cwd, ['diff', '--name-only']);

  console.log(`Version ${current} -> ${next}`);
  console.log('Updated files, not staged:');
  console.log(names || '(no diff)');
}

main();
