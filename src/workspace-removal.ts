import { AsyncLocalStorage } from 'node:async_hooks';
import { lstat, realpath, rm as rmDirectory } from 'node:fs/promises';
import path from 'node:path';
import { workspaceKey } from './core';
import type { ManagedWindowFacts } from './deletion-types';
import { fileUriMetadata } from './file-uri';
import { workspaceStorageRoot } from './paths';
import type { WorkspaceEntry } from './types';

/** Message shown when this window cannot be the one that deletes its own storage. */
export const currentWindowMessage =
  'This workspace is open in the current window. Open an empty Cursor window, close this workspace window, then delete its data from Manage Chats there.';

/**
 * Reject a storage id that is not one direct child name.
 * Cursor ids are not required to be UUIDs.
 */
export function assertStorageId(id: string): void {
  if (
    !id ||
    id === '.' ||
    id === '..' ||
    id.includes('\0') ||
    id.includes('/') ||
    id.includes('\\') ||
    id.includes(':') ||
    path.isAbsolute(id) ||
    path.win32.isAbsolute(id)
  )
    throw new Error('Workspace storage id is not a single directory name.');
}

/** True when `child` is `parent` or a path inside it. */
function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);

  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

/** Resolved directory that is safe to delete for this entry. */
export async function resolveWorkspaceDirectory(
  /** Cursor user-data directory. */
  userDataRoot: string,
  /** Entry whose directory is being checked. */
  entry: WorkspaceEntry,
): Promise<string> {
  assertStorageId(entry.storageId);
  const storage = workspaceStorageRoot(userDataRoot);
  const target = path.join(storage, entry.storageId);
  const targetStat = await lstat(target);

  if (targetStat.isSymbolicLink() || !targetStat.isDirectory())
    throw new Error('Workspace storage must be a real directory.');
  const database = path.join(target, 'state.vscdb');
  const databaseStat = await lstat(database);

  if (databaseStat.isSymbolicLink() || !databaseStat.isFile())
    throw new Error('Workspace database must be a real file.');

  const globalDatabase = path.join(
    userDataRoot,
    'User',
    'globalStorage',
    'state.vscdb',
  );

  const globalStat = await lstat(globalDatabase);

  if (globalStat.isSymbolicLink() || !globalStat.isFile())
    throw new Error('Global database must be a real file.');
  const realStorage = await realpath(storage);
  const realTarget = await realpath(target);

  if (path.dirname(realTarget) !== realStorage)
    throw new Error(
      'Workspace storage is not a direct child of workspaceStorage.',
    );
  if ((await realpath(database)) !== (await realpath(entry.workspaceDbPath)))
    throw new Error('Workspace database path does not match this storage id.');
  if ((await realpath(globalDatabase)) !== (await realpath(entry.globalDbPath)))
    throw new Error(
      'Global database does not belong to this user-data directory.',
    );
  const user = await realpath(userDataRoot);
  const userFolder = await realpath(path.join(userDataRoot, 'User'));

  const globalFolder = await realpath(
    path.join(userDataRoot, 'User', 'globalStorage'),
  );

  const forbidden = new Set([
    user,
    userFolder,
    realStorage,
    globalFolder,
    path.parse(realTarget).root,
  ]);

  if (forbidden.has(realTarget))
    throw new Error('Refusing to delete a profile or filesystem root.');

  const project =
    entry.identity?.uri.scheme === 'file'
      ? fileUriMetadata(entry.identity.uri).fsPath
      : undefined;

  if (project) {
    let realProject = path.resolve(project);

    try {
      realProject = await realpath(project);
    } catch {
      /* A missing project path is not proof that it lives inside storage. */
    }

    if (isInside(realTarget, realProject))
      throw new Error(
        'Project files are inside this workspace storage, so they cannot be kept.',
      );
  }

  return target;
}

/**
 * Refuse workspace-data deletion for the open window.
 * Identity is used only when the physical database path is unknown.
 */
export function workspaceDataRefusal(
  /** Candidate workspace. */
  entry: WorkspaceEntry,
  /** Facts about the window that requested deletion. */
  current: ManagedWindowFacts,
  /** Realpaths already computed for the database files. */
  resolved?: {
    /** Real path of the open window database. */
    database?: string;
    /** Real path of the candidate database. */
    target?: string;
  },
): string | undefined {
  if (!current.emptyWindow && !current.database && !current.identity)
    return currentWindowMessage;
  if (
    resolved?.database &&
    resolved.target &&
    resolved.database === resolved.target
  )
    return currentWindowMessage;
  if (
    !current.database &&
    current.identity &&
    entry.identity &&
    workspaceKey(current.identity.kind, current.identity.uri) ===
      workspaceKey(entry.identity.kind, entry.identity.uri)
  )
    return currentWindowMessage;

  return undefined;
}

/** One directory-removal attempt. Production uses Node's `rm`. */
type DirectoryRemoval = (
  directory: string,
  options: { recursive: boolean; force: boolean },
) => Promise<void>;

/** Keeps a test replacement on the current async call, so parallel tests do not share it. */
const removalScope = new AsyncLocalStorage<DirectoryRemoval>();

/**
 * Run `fn` with one replacement for each directory-removal attempt.
 * A thrown `EBUSY` or `EPERM` still uses the retry loop.
 */
export function withDirectoryRemoval<T>(
  /** Replacement for one `rm` attempt. */
  remove: DirectoryRemoval,
  fn: () => Promise<T>,
): Promise<T> {
  return removalScope.run(remove, fn);
}

/**
 * Delete one verified directory.
 * At most three attempts and one second of backoff, without Node's nested retries.
 */
export async function removeWorkspaceDirectory(
  /** Directory returned by `resolveWorkspaceDirectory`. */
  directory: string,
): Promise<void> {
  const delays = [0, 200, 400];
  let last: unknown;

  for (const delay of delays) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));

    try {
      const remove = removalScope.getStore();

      if (remove) await remove(directory, { recursive: true, force: true });
      else await rmDirectory(directory, { recursive: true, force: true });
      last = undefined;
      break;
    } catch (error) {
      last = error;

      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? error.code
          : undefined;

      if (code !== 'EBUSY' && code !== 'EPERM') throw error;
    }
  }

  if (last) throw last;

  try {
    await lstat(directory);
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? error.code
        : undefined;

    if (code === 'ENOENT') return;

    throw error;
  }

  throw new Error('Workspace data directory is still present.');
}

/** Size and mtime token for the database and its WAL, without reading rows. */
export async function databaseToken(database: string): Promise<string> {
  const main = await lstat(database);
  let wal = '0:0';

  try {
    const extra = await lstat(`${database}-wal`);

    wal = `${extra.mtimeMs}:${extra.size}`;
  } catch {
    /* A database without a WAL is a valid token. */
  }

  return `${main.mtimeMs}:${main.size}:${wal}`;
}
