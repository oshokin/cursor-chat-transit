import fs from 'node:fs';
import path from 'node:path';
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

/** node:test process; its exit status is this script's exit status. */
const result = spawnSync(
  process.execPath,
  [
    '--import',
    'tsx',
    '--test',
    ...(watch ? ['--watch'] : []),
    ...selected.sort(),
  ],
  { cwd: root, stdio: 'inherit', shell: false },
);

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
