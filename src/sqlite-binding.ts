import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import type Database from 'better-sqlite3';

/** Load the vendored native driver; development installs use the same pinned npm package. */
export function sqliteBinding(): typeof Database {
  if (Number(process.versions.napi || 0) < 10)
    throw new Error(
      'The bundled SQLite driver requires a Cursor runtime with Node-API 10.',
    );
  const load = createRequire(__filename);
  const bundled = path.join(__dirname, '../vendor/better-sqlite3');

  return load(
    fs.existsSync(bundled) ? bundled : 'better-sqlite3',
  ) as typeof Database;
}
