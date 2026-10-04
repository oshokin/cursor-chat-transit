import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { findSqliteExecutable } from '../src/sqlite';
import { spawnSync } from 'node:child_process';

/** Repository root. */
const root = path.resolve(__dirname, '..');
/** Raw CLI arguments after the node script path. */
const args = process.argv.slice(2);
/** Re-run tests when files change. */
const watch = args.includes('--watch');
/** Restrict the run to `*.sqlite.test.ts`. */
const sqliteOnly = args.includes('--sqlite');
/** Restrict the run to tests that do not need sqlite3. */
const unitOnly = args.includes('--unit');

if (!unitOnly && !findSqliteExecutable()) {
  throw new Error(
    'sqlite3 is required for integration tests. Install it on PATH or run test:unit.',
  );
}

/** Directory names passed after the flags. */
const dirs = args.filter(
  (arg) => arg !== '--watch' && arg !== '--sqlite' && arg !== '--unit',
);

/** Test files collected from the requested directories. */
const files: string[] = [];

/** Recursively collect `*.test.ts` files; Extension Host tests use a different runner. */
function visit(dir: string): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'host') continue;
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) visit(full);
    else if (entry.isFile() && /\.test\.ts$/.test(entry.name)) files.push(full);
  }
}

/** True when the file is an SQLite integration test, not a unit test. */
function isSqliteFile(file: string): boolean {
  return /\.sqlite\.test\.ts$/.test(file);
}

for (const dir of dirs.length ? dirs : ['test']) visit(path.resolve(root, dir));
/** Files that will actually run after `--unit` / `--sqlite` filters. */
let selected = files;

if (sqliteOnly) selected = files.filter(isSqliteFile);
if (unitOnly) selected = files.filter((file) => !isSqliteFile(file));
if (!selected.length) throw new Error('No test files found');

/**
 * Tests inside one file normally run one at a time, so a long SQLite file
 * becomes the whole run. These files use a private temp directory per test,
 * so several may run at once.
 * Windows process creation is already the slow part: extra sqlite3.exe
 * processes make every test slower, so those files stay serial there.
 * Files that patch process-wide hooks stay serial on every OS.
 */
const sqliteTestConcurrency = 4;
/** Intra-file parallelism. Off on Windows, where each sqlite3.exe is expensive. */
const parallelSqlite = process.platform !== 'win32';

/** SQLite files whose tests share module-level hooks. */
const serialSqliteFiles = new Set([
  'read-transaction.sqlite.test.ts',
  'transfer.sqlite.test.ts',
]);

/** Load a SQLite test file inside a concurrent suite. */
function concurrentSqliteWrapper(
  dir: string,
  file: string,
  index: number,
): string {
  const wrapper = path.join(dir, `${index}-${path.basename(file)}.mjs`);

  fs.writeFileSync(
    wrapper,
    `import { describe } from 'node:test';
describe(${JSON.stringify(path.basename(file, '.ts'))}, { concurrency: ${sqliteTestConcurrency} }, async () => {
  await import(${JSON.stringify(pathToFileURL(file).href)});
});
`,
  );

  return wrapper;
}

/** Scratch directory for generated suites; absent in watch mode. */
let scratch: string | undefined;
/** Files passed to `node --test`. */
let entrypoints = selected.sort();

if (!watch) {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cct-test-'));

  entrypoints = entrypoints.map((file, index) =>
    parallelSqlite &&
    isSqliteFile(file) &&
    !serialSqliteFiles.has(path.basename(file))
      ? concurrentSqliteWrapper(scratch!, file, index)
      : file,
  );
}

/**
 * Past the CPU count, more workers only pay off when a test is waiting on
 * sqlite3. On Windows that wait is the process start itself.
 */
const cpuCount = os.availableParallelism();
const workers = String(parallelSqlite ? Math.max(cpuCount, 8) : cpuCount);

/** node:test process; its exit status is this script's exit status. */
try {
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--test',
      // A paused sqlite pipe keeps the worker alive after the last test.
      // Exit once every test and hook has finished.
      ...(watch
        ? ['--watch']
        : ['--test-force-exit', '--test-concurrency', workers]),
      ...entrypoints,
    ],
    { cwd: root, stdio: 'inherit', shell: false },
  );

  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
}
