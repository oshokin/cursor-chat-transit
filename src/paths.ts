import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mapInBatches } from './bounded-io';
import { identityFromWorkspaceJson, workspaceKey } from './core';
import { workspacePresentation } from './workspace-presentation';
import type { WorkspaceEntry, WorkspaceIdentity } from './types';

/** Default local Cursor user-data directory for this OS. */
export function getDefaultCursorUserDir(
  /** Operating system id used for paths. */
  platform: NodeJS.Platform = process.platform,
  home = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform === 'darwin') {
    return path.posix.join(home, 'Library', 'Application Support', 'Cursor');
  }

  if (platform === 'win32') {
    const appData = env.APPDATA || path.win32.join(home, 'AppData', 'Roaming');

    return path.win32.join(appData, 'Cursor');
  }

  const xdg = env.XDG_CONFIG_HOME;

  if (xdg && path.posix.isAbsolute(xdg)) return path.posix.join(xdg, 'Cursor');

  return path.posix.join(home, '.config', 'Cursor');
}

/** Keep existing directories, de-duplicated by realpath. */
function uniqueExisting(dirs: Array<string | undefined | null>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const dir of dirs) {
    if (!dir) continue;

    try {
      if (!fs.existsSync(dir)) continue;
      const resolved = fs.realpathSync(dir);

      if (seen.has(resolved)) continue;
      seen.add(resolved);
      out.push(dir);
    } catch {
      /* skip unreadable */
    }
  }

  return out;
}

/** True when `p` exists and is a regular file. */
function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** True when `p` exists and is a directory. */
function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Return whether a user-data dir has both global and workspace storage. */
function hasPairedDbs(
  /** Cursor user-data directory. */
  userDir: string,
): boolean {
  const globalDb = path.join(userDir, 'User', 'globalStorage', 'state.vscdb');
  const wsRoot = path.join(userDir, 'User', 'workspaceStorage');

  return isFile(globalDb) && isDir(wsRoot);
}

/** Candidate local user-data roots that contain workspaceStorage. */
function listStorageRoots(
  /** {
  configured user data dir,
  extra candidates = [],
}. */
  {
    configuredUserDataDir,
    extraCandidates = [],
  }: {
    /** User-data directory from settings, when the user pointed at one. */
    configuredUserDataDir?: string;
    /** Extra candidate roots, such as isolated host fixtures. */
    extraCandidates?: string[];
  } = {},
): string[] {
  const ordered: string[] = [];

  if (configuredUserDataDir) ordered.push(configuredUserDataDir);
  ordered.push(...uniqueExisting([getDefaultCursorUserDir()]));
  ordered.push(...extraCandidates);

  return uniqueExisting(ordered).filter((/** Directory path. */ dir) =>
    fs.existsSync(path.join(dir, 'User', 'workspaceStorage')),
  );
}

/** Prefer a paired global+workspace root; never mix workspace A with global B. */
export function preferStorageRoot(
  options: {
    /** User-data directory from settings, when the user pointed at one. */
    configuredUserDataDir?: string;
    /** Extra candidate roots, such as isolated host fixtures. */
    extraCandidates?: string[];
  } = {},
): string {
  if (options.configuredUserDataDir) {
    const configured = path.resolve(options.configuredUserDataDir);

    if (!hasPairedDbs(configured)) {
      throw new Error(
        `Configured Cursor data directory is incomplete: ${configured}`,
      );
    }

    return configured;
  }

  const roots = listStorageRoots(options);
  const paired = roots.find(hasPairedDbs);

  return paired || roots[0] || getDefaultCursorUserDir();
}

/** Path to `User/globalStorage/state.vscdb`. */
function globalDbPath(
  /** Cursor user-data directory. */
  userDir: string,
): string {
  return path.join(userDir, 'User', 'globalStorage', 'state.vscdb');
}

/** Path to `User/workspaceStorage`. */
export function workspaceStorageRoot(
  /** Cursor user-data directory. */
  userDir: string,
): string {
  return path.join(userDir, 'User', 'workspaceStorage');
}

/**
 * Direct `workspaceStorage` children that have no `state.vscdb`.
 * Manage-only. These directories are not transfer sources.
 */
export function listIncompleteWorkspaceDirs(
  /** Cursor user-data directory. */
  userDir: string,
): string[] {
  const root = workspaceStorageRoot(userDir);

  if (!fs.existsSync(root)) return [];
  const ids: string[] = [];

  for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
    if (!ent.isDirectory() || ent.isSymbolicLink()) continue;
    if (ent.name === '.' || ent.name === '..') continue;
    const db = path.join(root, ent.name, 'state.vscdb');

    if (!fs.existsSync(db)) ids.push(ent.name);
  }

  return ids;
}

/** Parse workspace.json text. Invalid metadata is an unidentified storage. */
function identityFromMetaText(text: string): WorkspaceIdentity | undefined {
  try {
    return identityFromWorkspaceJson(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/** Parse `workspace.json` in a storage folder, if present. */
function readWorkspaceMeta(storageDir: string): WorkspaceIdentity | undefined {
  const jsonPath = path.join(storageDir, 'workspace.json');

  try {
    if (!fs.existsSync(jsonPath) || !isFile(jsonPath)) return undefined;

    return identityFromMetaText(fs.readFileSync(jsonPath, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * One physical storage, read again before a write.
 * Does not list the rest of the profile.
 */
export async function readStorageEntry(
  /** Cursor user-data directory. */
  userDir: string,
  /** Storage directory name under workspaceStorage. */
  storageId: string,
): Promise<WorkspaceEntry | undefined> {
  const storageDir = path.join(workspaceStorageRoot(userDir), storageId);
  const dbPath = path.join(storageDir, 'state.vscdb');

  let stat: fs.Stats;

  try {
    stat = await fs.promises.stat(dbPath);
  } catch {
    return undefined;
  }

  if (!stat.isFile()) return undefined;
  let identity: WorkspaceIdentity | undefined;

  try {
    identity = identityFromMetaText(
      await fs.promises.readFile(
        path.join(storageDir, 'workspace.json'),
        'utf8',
      ),
    );
  } catch {
    identity = undefined;
  }

  let mtime = stat.mtimeMs || 0;

  try {
    const wal = await fs.promises.stat(`${dbPath}-wal`);

    if (wal.isFile()) mtime = Math.max(mtime, wal.mtimeMs);
  } catch {
    /* The main database time remains the activity hint. */
  }

  return {
    storageRoot: userDir,
    storageId,
    workspaceDbPath: dbPath,
    globalDbPath: globalDbPath(userDir),
    mtime,
    identity,
    key: identity
      ? workspaceKey(identity.kind, identity.uri)
      : `id:${storageId}`,
  };
}

/** Latest local storage write is a recency hint, not proof of the last editor visit. */
function storageActivity(dbPath: string, mainMtime: number): number {
  try {
    const wal = fs.statSync(`${dbPath}-wal`);

    return wal.isFile() ? Math.max(mainMtime, wal.mtimeMs) : mainMtime;
  } catch {
    return mainMtime;
  }
}

/** List workspaceStorage entries, using DB + WAL activity without opening SQLite. */
export function listWorkspaceEntries(
  /** Cursor user-data directory. */
  userDir: string,
): WorkspaceEntry[] {
  const root = workspaceStorageRoot(userDir);
  const results: WorkspaceEntry[] = [];

  if (!fs.existsSync(root)) return results;

  for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const dbPath = path.join(root, ent.name, 'state.vscdb');
    let stat: fs.Stats;

    try {
      stat = fs.statSync(dbPath);
    } catch {
      continue;
    }

    if (!stat.isFile()) continue;
    const identity = readWorkspaceMeta(path.join(root, ent.name));

    results.push({
      storageRoot: userDir,
      storageId: ent.name,
      workspaceDbPath: dbPath,
      globalDbPath: globalDbPath(userDir),
      mtime: storageActivity(dbPath, stat.mtimeMs || 0),
      identity,
      key: identity
        ? workspaceKey(identity.kind, identity.uri)
        : `id:${ent.name}`,
    });
  }

  results.sort((a, b) => b.mtime - a.mtime);

  return results;
}

/**
 * Same inventory as `listWorkspaceEntries`, read with bounded async stat calls.
 * Cancellation does not start another batch. An in-flight stat is ignored by
 * returning no rows rather than a partial snapshot.
 */
export async function listWorkspaceEntriesAsync(
  /** Cursor user-data directory. */
  userDir: string,
  options?: {
    /** Refresh that must not publish this snapshot. */
    signal?: AbortSignal;
  },
): Promise<WorkspaceEntry[]> {
  if (options?.signal?.aborted) return [];
  const root = workspaceStorageRoot(userDir);
  let names: string[];

  try {
    const dirents = await fs.promises.readdir(root, { withFileTypes: true });

    names = dirents.filter((ent) => ent.isDirectory()).map((ent) => ent.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];

    throw error;
  }

  const entries: WorkspaceEntry[] = [];

  try {
    for await (const batch of mapInBatches(
      names,
      (storageId) => readStorageEntry(userDir, storageId),
      options?.signal,
    )) {
      if (options?.signal?.aborted) return [];

      for (const entry of batch) if (entry) entries.push(entry);
    }
  } catch (error) {
    if (options?.signal?.aborted) return [];

    throw error;
  }

  if (options?.signal?.aborted) return [];
  entries.sort((a, b) => b.mtime - a.mtime);

  return entries;
}

/** Human-readable label; SSH host aliases never replace workspace identity. */
export function displayLabel(entry: WorkspaceEntry): string {
  const label = workspacePresentation(entry);

  if (!entry.identity) return label.name;
  const place = label.location === 'This computer' ? 'local' : label.location;

  return `${label.name} (${place})`;
}
