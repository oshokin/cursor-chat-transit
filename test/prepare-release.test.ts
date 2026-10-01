import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { changelogSection } from '../scripts/changelog-section';

/** Repository root that holds release-it and its config. */
const project = path.resolve(__dirname, '..');
/** Prepare script invoked by each fixture. */
const script = path.join(project, 'scripts', 'prepare-release.ts');

/** Run git in a fixture and keep its output when it fails. */
function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr || result.stdout);

  return result.stdout.trim();
}

/** Commit with a fixture identity so the developer git config is untouched. */
function commit(repo: string, message: string, body?: string): void {
  const args = [
    '-c',
    'user.email=test@example.com',
    '-c',
    'user.name=Test',
    'commit',
    '--allow-empty',
    '-m',
    message,
  ];

  if (body) args.push('-m', body);
  git(repo, args);
}

/** package.json version in a fixture. */
function versionOf(repo: string): string {
  return (
    JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')) as {
      version: string;
    }
  ).version;
}

/** Run the prepare script the way Task does, without a shell. */
function runPrepare(repo: string, args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', script, ...args], {
    cwd: repo,
    encoding: 'utf8',
  });
}

/** Options for the temporary repository. */
interface FixtureOptions {
  /** When false, the fixture has no `v1.0.0` tag. Defaults to tagging it. */
  tag?: boolean;
}

/** Paths created for one prepare-release fixture. */
interface FixturePaths {
  /** Working copy. */
  repo: string;
  /** Bare origin that `git fetch` reads. */
  origin: string;
}

/** Temporary repository whose origin is a local bare repo. */
function fixture(options?: FixtureOptions): FixturePaths {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cct-release-'));
  const repo = path.join(root, 'repo');
  const origin = path.join(root, 'origin.git');

  fs.mkdirSync(repo);
  git(repo, ['init', '-b', 'master']);

  fs.writeFileSync(
    path.join(repo, 'package.json'),
    `${JSON.stringify(
      { name: 'cursor-chat-transit', version: '1.0.0', private: true },
      null,
      2,
    )}\n`,
  );

  fs.writeFileSync(
    path.join(repo, 'package-lock.json'),
    `${JSON.stringify(
      {
        name: 'cursor-chat-transit',
        version: '1.0.0',
        lockfileVersion: 3,
        requires: true,
        packages: {
          '': { name: 'cursor-chat-transit', version: '1.0.0' },
        },
      },
      null,
      2,
    )}\n`,
  );

  fs.writeFileSync(
    path.join(repo, 'CHANGELOG.md'),
    '# Changelog\n\n## 1.0.0\n\n- Original section that must survive.\n',
  );

  fs.copyFileSync(
    path.join(project, '.release-it.json'),
    path.join(repo, '.release-it.json'),
  );

  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules\n');

  fs.symlinkSync(
    path.join(project, 'node_modules'),
    path.join(repo, 'node_modules'),
    'dir',
  );

  git(repo, [
    'add',
    'package.json',
    'package-lock.json',
    'CHANGELOG.md',
    '.release-it.json',
    '.gitignore',
  ]);

  commit(repo, 'chore: baseline');
  if (options?.tag !== false) git(repo, ['tag', 'v1.0.0']);
  git(root, ['init', '--bare', '-b', 'master', origin]);
  git(repo, ['remote', 'add', 'origin', origin]);
  git(repo, ['push', 'origin', 'HEAD:master']);
  if (options?.tag !== false) git(repo, ['push', 'origin', 'tag', 'v1.0.0']);

  return { repo, origin };
}

/** Index must stay empty; version files may be unstaged. */
function assertUnstaged(repo: string): void {
  assert.equal(git(repo, ['diff', '--cached', '--name-only']), '');
}

test('commits do not change the version, and several fixes are one patch', async () => {
  const { repo, origin } = fixture();
  const originHead = git(repo, ['ls-remote', origin, 'refs/heads/master']);

  commit(repo, 'fix: correct a path');
  commit(repo, 'fix: reject damaged metadata');
  assert.equal(versionOf(repo), '1.0.0');
  const head = git(repo, ['rev-parse', 'HEAD']);

  const result = runPrepare(repo, ['prepare']);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Version 1\.0\.0 -> 1\.0\.1/);
  assert.equal(versionOf(repo), '1.0.1');

  const lock = JSON.parse(
    fs.readFileSync(path.join(repo, 'package-lock.json'), 'utf8'),
  ) as { version: string; packages: { '': { version: string } } };

  assert.equal(lock.version, '1.0.1');
  assert.equal(lock.packages[''].version, '1.0.1');
  const changelog = fs.readFileSync(path.join(repo, 'CHANGELOG.md'), 'utf8');

  assert.match(changelog, /## \[1\.0\.1\]/);
  assert.match(changelog, /Original section that must survive\./);
  assert.ok(changelog.indexOf('## [1.0.1]') < changelog.indexOf('## 1.0.0'));
  assertUnstaged(repo);
  assert.equal(git(repo, ['rev-parse', 'HEAD']), head);
  assert.deepEqual(git(repo, ['tag', '--list']).split('\n'), ['v1.0.0']);

  assert.equal(
    git(repo, ['ls-remote', origin, 'refs/heads/master']),
    originHead,
  );

  assert.equal(git(repo, ['ls-remote', origin, 'refs/tags/v1.0.1']), '');
});

test('preview writes nothing', () => {
  const { repo } = fixture();

  commit(repo, 'fix: correct a path');
  const before = git(repo, ['status', '--porcelain']);
  const result = runPrepare(repo, ['preview']);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /1\.0\.0\.\.\.1\.0\.1|1\.0\.1/);
  assert.equal(git(repo, ['status', '--porcelain']), before);
  assert.equal(versionOf(repo), '1.0.0');
  assertUnstaged(repo);
});

test('a feature recommends minor and a breaking change recommends major', () => {
  const feature = fixture();

  commit(feature.repo, 'feat: export canvases');
  const minor = runPrepare(feature.repo, ['prepare']);

  assert.equal(minor.status, 0, minor.stderr || minor.stdout);
  assert.equal(versionOf(feature.repo), '1.1.0');

  const breaking = fixture();

  commit(
    breaking.repo,
    'feat!: drop json exports',
    'BREAKING CHANGE: JSON exports are not imported.',
  );

  const major = runPrepare(breaking.repo, ['prepare']);

  assert.equal(major.status, 0, major.stderr || major.stdout);
  assert.equal(versionOf(breaking.repo), '2.0.0');
});

test('docs, test, and ci commits do not bump unless a version is explicit', () => {
  const { repo } = fixture();

  commit(repo, 'docs: clarify install');
  commit(repo, 'test: cover restoration');
  commit(repo, 'ci: adjust the workflow');
  const auto = runPrepare(repo, ['prepare']);

  assert.equal(auto.status, 0, auto.stderr || auto.stdout);
  assert.match(auto.stdout, /No releasable changes/);
  assert.equal(versionOf(repo), '1.0.0');
  assert.equal(git(repo, ['status', '--porcelain']), '');

  const explicit = runPrepare(repo, ['prepare', 'patch']);

  assert.equal(explicit.status, 0, explicit.stderr || explicit.stdout);
  assert.equal(versionOf(repo), '1.0.1');
  assertUnstaged(repo);
});

test('an explicit smaller bump is applied and the warning stays visible', () => {
  const { repo } = fixture();

  commit(repo, 'feat!: drop json exports');
  const result = runPrepare(repo, ['prepare', 'patch']);
  const output = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.status, 0, output);
  assert.match(output, /recommended bump is "major"/);
  assert.match(output, /overridden with "patch"/);
  assert.equal(versionOf(repo), '1.0.1');
});

test('a second prepare stops while the first result is uncommitted', () => {
  const { repo } = fixture();

  commit(repo, 'fix: correct a path');
  assert.equal(runPrepare(repo, ['prepare']).status, 0);
  const again = runPrepare(repo, ['prepare']);

  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /not clean/);
  assert.equal(versionOf(repo), '1.0.1');
});

test('a prepared version that is committed is not bumped again before publish', () => {
  const { repo } = fixture();

  commit(repo, 'fix: correct a path');
  assert.equal(runPrepare(repo, ['prepare']).status, 0);
  git(repo, ['add', 'package.json', 'package-lock.json', 'CHANGELOG.md']);
  commit(repo, 'chore(release): 1.0.1');
  const again = runPrepare(repo, ['prepare']);

  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /already prepared/);
  assert.equal(versionOf(repo), '1.0.1');
  assert.equal(git(repo, ['status', '--porcelain']), '');
});

test('a prerelease tag is not the baseline', () => {
  const { repo } = fixture();

  commit(repo, 'fix: before the beta');
  git(repo, ['tag', 'v1.0.1-beta']);
  git(repo, ['push', 'origin', 'tag', 'v1.0.1-beta']);
  commit(repo, 'fix: after the beta');
  const result = runPrepare(repo, ['prepare']);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(versionOf(repo), '1.0.1');

  const notes = fs.readFileSync(path.join(repo, 'CHANGELOG.md'), 'utf8');
  const section = changelogSection(notes, '1.0.1');

  assert.match(section, /before the beta/);
  assert.match(section, /after the beta/);
  assert.equal(notes.match(/^## /gm)?.length, 2);
});

test('prepare refuses when origin cannot be fetched', () => {
  const { repo } = fixture();

  commit(repo, 'fix: correct a path');
  git(repo, ['remote', 'set-url', 'origin', '/this/path/does-not-exist.git']);
  const result = runPrepare(repo, ['prepare']);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Could not fetch tags/);
  assert.equal(versionOf(repo), '1.0.0');
});

test('prepare refuses when the recorded version has no stable tag', () => {
  const { repo } = fixture({ tag: false });

  commit(repo, 'fix: correct a path');
  const result = runPrepare(repo, ['prepare']);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /No stable release tag/);
  assert.equal(versionOf(repo), '1.0.0');
});
