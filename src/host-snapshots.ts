import { randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { SqliteSession } from './sqlite-session';

const HOST_DIR = 'anysphere.cursor-agent-host';
const MANIFEST_KEY = 'agentHost:sessionManifest';
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HEX = /^[0-9a-f]{64}$/;

/** Largest host snapshot metadata file accepted during verification. */
export const HOST_SNAPSHOT_METADATA_BYTES = 256 * 1024;

/** An exact, self-contained host-native session component. */
export interface HostSnapshot {
  sessionId: string;
  database: string;
  meta: string;
}

/** Host storage belonging to the same Cursor profile as a renderer workspace. */
export function hostStorageRoot(userDataDir: string): string {
  return path.join(userDataDir, 'User', 'globalStorage', HOST_DIR);
}

/** Cursor user-data root derived from `User/globalStorage/state.vscdb`. */
export function userDataDirFromGlobalDb(globalDbPath: string): string {
  return path.resolve(path.dirname(globalDbPath), '..', '..');
}

/** Return a usable host session path without following directory aliases. */
export async function discoverHostSession(
  userDataDir: string,
  sessionId: string,
): Promise<string | undefined> {
  if (!ID.test(sessionId) || sessionId.includes('..')) return undefined;
  const root = hostStorageRoot(userDataDir);
  const dir = path.join(root, 'sessions', sessionId);

  try {
    if (!(await lstat(root)).isDirectory()) return undefined;
    if (!(await lstat(dir)).isDirectory()) return undefined;
    if ((await lstat(dir)).isSymbolicLink()) return undefined;

    return dir;
  } catch {
    return undefined;
  }
}

/** Create a WAL-aware database snapshot and copy its listing sidecar. */
export async function snapshotHostSession(opts: {
  userDataDir: string;
  sessionId: string;
  stagingDir: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  busyTimeoutMs?: number;
}): Promise<HostSnapshot | undefined> {
  const source = await discoverHostSession(opts.userDataDir, opts.sessionId);

  if (!source) return undefined;
  const sourceDb = path.join(source, 'session.sqlite');
  const sourceMeta = path.join(source, 'meta.json');

  await requireRegular(sourceDb, 'host session database');
  await requireRegular(sourceMeta, 'host session metadata');
  const out = path.join(opts.stagingDir, `host-${randomUUID()}`);

  await mkdir(out, { recursive: true, mode: 0o700 });
  const database = path.join(out, 'session.sqlite');
  const meta = path.join(out, 'meta.json');

  const session = await SqliteSession.open({
    database: sourceDb,
    readOnly: true,
    mustExist: true,
    signal: opts.signal,
    timeoutMs: opts.timeoutMs,
    busyTimeoutMs: opts.busyTimeoutMs,
  });

  try {
    // VACUUM INTO uses SQLite's own read transaction and therefore includes WAL.
    await session.exec(`VACUUM INTO ${sqlString(database)};`);
  } finally {
    await session.close();
  }

  await writeFile(meta, await readFile(sourceMeta), {
    flag: 'wx',
    mode: 0o600,
  });

  try {
    await validateHostSnapshot({ sessionId: opts.sessionId, database, meta });

    return { sessionId: opts.sessionId, database, meta };
  } catch (error) {
    await rm(out, { recursive: true, force: true });

    throw error;
  }
}

/** Fail closed unless the native component is internally complete and owned by id. */
export async function validateHostSnapshot(
  snapshot: HostSnapshot,
): Promise<void> {
  if (!ID.test(snapshot.sessionId) || snapshot.sessionId.includes('..'))
    throw new Error('Invalid host session id.');
  await requireRegular(snapshot.database, 'host snapshot database');
  await requireRegular(snapshot.meta, 'host snapshot metadata');
  const metaBytes = await readFile(snapshot.meta);

  if (metaBytes.length > HOST_SNAPSHOT_METADATA_BYTES)
    throw new Error('Host snapshot meta.json is too large.');
  let meta: Record<string, unknown>;

  try {
    const value: unknown = JSON.parse(metaBytes.toString('utf8'));

    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error();
    meta = value as Record<string, unknown>;
  } catch {
    throw new Error('Host snapshot meta.json is invalid.');
  }

  if (
    meta.schemaVersion !== 1 ||
    meta.sessionId !== snapshot.sessionId ||
    !['migrated-from-renderer-cas', 'host-native'].includes(
      String(meta.origin),
    ) ||
    !Number.isFinite(meta.createdAtMs) ||
    typeof meta.isArchived !== 'boolean' ||
    typeof meta.latestRootBlobIdHex !== 'string' ||
    !HEX.test(meta.latestRootBlobIdHex)
  )
    throw new Error('Host snapshot meta.json does not match the session.');

  const db = await SqliteSession.open({
    database: snapshot.database,
    readOnly: true,
    mustExist: true,
  });

  try {
    const version = (await db.exec('PRAGMA user_version;')).trim();

    if (version !== '1')
      throw new Error('Unsupported host snapshot user_version.');
    const schema: string[] = [];

    await db.rows(
      `SELECT name FROM sqlite_master
       WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;`,
      [],
      (row) => {
        schema.push(String(row[0]));
      },
    );

    if (schema.join(',') !== 'ItemTable,cursorDiskKV')
      throw new Error('Host snapshot schema is not recognized.');

    for (const table of ['ItemTable', 'cursorDiskKV']) {
      const columns: string[] = [];

      await db.rows(`PRAGMA table_info(${table});`, [], (row) => {
        columns.push(`${String(row[1])}:${String(row[2]).toUpperCase()}`);
      });

      if (columns.join(',') !== 'key:TEXT,value:BLOB')
        throw new Error('Host snapshot table schema is not recognized.');
    }

    const manifestText = (
      await db.text('SELECT CAST(value AS TEXT) FROM ItemTable WHERE key=?;', [
        MANIFEST_KEY,
      ])
    ).trim();

    if (!manifestText) throw new Error('Host snapshot manifest is missing.');
    const manifest = JSON.parse(manifestText) as Record<string, unknown>;
    const root = manifest.latestRootBlobIdHex;
    const manifestVersion = manifest.manifestVersion;

    if (
      (manifestVersion !== 1 && manifestVersion !== 2) ||
      manifest.sessionId !== snapshot.sessionId ||
      typeof root !== 'string' ||
      !HEX.test(root) ||
      root !== meta.latestRootBlobIdHex ||
      manifest.origin !== meta.origin ||
      manifest.createdAtMs !== meta.createdAtMs ||
      !isNonnegativeInteger(manifest.migratedBlobCount) ||
      (manifestVersion === 2 && !isListHeads(manifest.listHeads)) ||
      (manifestVersion === 2 &&
        manifest.latestStructureIdHex !== undefined &&
        (typeof manifest.latestStructureIdHex !== 'string' ||
          !HEX.test(manifest.latestStructureIdHex))) ||
      (manifestVersion === 2 &&
        manifest.conversionEpoch !== undefined &&
        !isNonnegativeInteger(manifest.conversionEpoch))
    )
      throw new Error('Host snapshot manifest is invalid.');

    const present = (
      await db.text(
        'SELECT 1 FROM cursorDiskKV WHERE key=? AND value IS NOT NULL LIMIT 1;',
        [`agentKv:blob:${root}`],
      )
    ).trim();

    if (present !== '1') throw new Error('Host snapshot root is missing.');
  } finally {
    await db.close();
  }
}

/** Privately stage, revalidate, and atomically publish under the original id. */
export async function publishHostSnapshot(opts: {
  userDataDir: string;
  snapshot: HostSnapshot;
  rendererCollision: boolean;
}): Promise<void> {
  if (opts.rendererCollision)
    throw new Error('Refusing host snapshot import: renderer id collision.');
  await validateHostSnapshot(opts.snapshot);
  const root = hostStorageRoot(opts.userDataDir);
  const sessions = path.join(root, 'sessions');
  const destination = path.join(sessions, opts.snapshot.sessionId);

  try {
    await lstat(destination);

    throw new Error('Refusing host snapshot import: host id collision.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  await mkdir(sessions, { recursive: true, mode: 0o700 });

  const staging = path.join(
    sessions,
    `.cct-${opts.snapshot.sessionId}-${randomUUID()}`,
  );

  await mkdir(staging, { mode: 0o700 });

  try {
    await writeFile(
      path.join(staging, 'session.sqlite'),
      await readFile(opts.snapshot.database),
      { flag: 'wx', mode: 0o600 },
    );

    await writeFile(
      path.join(staging, 'meta.json'),
      await readFile(opts.snapshot.meta),
      { flag: 'wx', mode: 0o600 },
    );

    await validateHostSnapshot({
      sessionId: opts.snapshot.sessionId,
      database: path.join(staging, 'session.sqlite'),
      meta: path.join(staging, 'meta.json'),
    });

    await chmod(staging, 0o700);
    await rename(staging, destination);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });

    throw error;
  }
}

/** True when the destination already owns this native session id. */
export async function hostSessionExists(
  userDataDir: string,
  sessionId: string,
): Promise<boolean> {
  return (await discoverHostSession(userDataDir, sessionId)) !== undefined;
}

async function requireRegular(file: string, label: string): Promise<void> {
  const stat = await lstat(file);

  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error(`${label} is not a regular file.`);
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function isNonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isListHeads(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const heads = value as Record<string, unknown>;

  return (
    Object.keys(heads).length === 3 &&
    isNonnegativeInteger(heads.turns) &&
    isNonnegativeInteger(heads.prompt) &&
    isNonnegativeInteger(heads.archives)
  );
}
