import fs from 'node:fs';
import path from 'node:path';

/** Ordered sqlite3 paths: configured, PATH, then platform fallbacks. */
function candidateExecutables(configured?: string): string[] {
  const out: string[] = [];

  if (configured) return path.isAbsolute(configured) ? [configured] : [];
  const pathVar = process.env.PATH || '';
  const sep = process.platform === 'win32' ? ';' : ':';
  const ext = process.platform === 'win32' ? '.exe' : '';

  for (const dir of pathVar.split(sep)) {
    if (dir) out.push(path.join(dir, `sqlite3${ext}`));
  }

  if (process.platform === 'win32') {
    out.push(
      'C:\\sqlite3\\sqlite3.exe',
      'C:\\Program Files\\sqlite3\\sqlite3.exe',
    );

    if (process.env.USERPROFILE) {
      out.push(
        path.join(
          process.env.USERPROFILE,
          'scoop\\apps\\sqlite\\current\\sqlite3.exe',
        ),
      );
    }
  } else {
    out.push(
      '/usr/bin/sqlite3',
      '/usr/local/bin/sqlite3',
      '/opt/homebrew/bin/sqlite3',
    );
  }

  return [...new Set(out.filter(Boolean))];
}

/** Locate the independent sqlite3 CLI used by oracle tests and developer tools. */
export function findSqliteExecutable(
  configured = process.env.SQLITE3_PATH,
): string | null {
  for (const candidate of candidateExecutables(configured)) {
    try {
      if (!fs.statSync(candidate).isFile()) continue;

      fs.accessSync(
        candidate,
        process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK,
      );

      return candidate;
    } catch {
      /* Try the next candidate. */
    }
  }

  return null;
}

/** Create an empty sqlite3 CLI init file for tests that invoke `-init`. */
export async function ensureInitFile(dir: string): Promise<string> {
  const initFile = path.join(dir, 'empty-sqliterc');

  await fs.promises.writeFile(initFile, '', { flag: 'w' });

  return initFile;
}
