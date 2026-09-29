import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** Return sqlite3 on PATH, if present. */
function findSqlite(): string | null {
  const names =
    process.platform === 'win32' ? ['sqlite3.exe', 'sqlite3'] : ['sqlite3'];
  const sep = process.platform === 'win32' ? ';' : ':';
  for (const dir of (process.env.PATH || '').split(sep)) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  for (const candidate of extraCandidates()) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Hosted-runner locations that package managers use after install. */
function extraCandidates(): string[] {
  if (process.platform === 'darwin') {
    return [
      '/opt/homebrew/opt/sqlite/bin/sqlite3',
      '/opt/homebrew/bin/sqlite3',
      '/usr/local/opt/sqlite/bin/sqlite3',
      '/usr/local/bin/sqlite3',
    ];
  }
  if (process.platform === 'win32') {
    return [
      'C:\\ProgramData\\chocolatey\\bin\\sqlite3.exe',
      'C:\\Program Files\\SQLite\\sqlite3.exe',
      'C:\\sqlite3\\sqlite3.exe',
    ];
  }
  return ['/usr/bin/sqlite3', '/usr/local/bin/sqlite3'];
}

/** Install sqlite3 from the OS package manager used on GitHub hosted runners. */
function installSqlite(): void {
  if (process.platform === 'linux') {
    const result = spawnSync('sudo', ['apt-get', 'install', '-y', 'sqlite3'], {
      stdio: 'inherit',
      shell: false,
    });
    if (result.status !== 0) throw new Error('Failed to install sqlite3');
    return;
  }
  if (process.platform === 'darwin') {
    const result = spawnSync('brew', ['install', 'sqlite'], {
      stdio: 'inherit',
      shell: false,
    });
    if (result.status !== 0)
      throw new Error('Failed to install sqlite3 with Homebrew');
    return;
  }
  if (process.platform === 'win32') {
    const result = spawnSync('choco', ['install', 'sqlite', '-y'], {
      stdio: 'inherit',
      shell: false,
    });
    if (result.status !== 0)
      throw new Error('Failed to install sqlite3 with Chocolatey');
  }
}

/** sqlite3 path found on PATH or after install. */
let exe = findSqlite();
if (!exe) {
  installSqlite();
  exe = findSqlite();
}
if (!exe) throw new Error('sqlite3 CLI is required for CI integration tests');
/** `sqlite3 --version` probe used to prove the binary runs. */
const ver = spawnSync(exe, ['--version'], { encoding: 'utf8', shell: false });
if (ver.status !== 0) throw new Error('sqlite3 --version failed');
process.stdout.write(ver.stdout);
if (process.env.GITHUB_ENV) {
  fs.appendFileSync(process.env.GITHUB_ENV, `SQLITE3_PATH=${exe}\n`);
}
if (process.env.GITHUB_PATH) {
  fs.appendFileSync(process.env.GITHUB_PATH, `${path.dirname(exe)}\n`);
}
