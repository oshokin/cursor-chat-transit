import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { compareText, validTimestamp } from './activity';
import { workspaceKey } from './core';
import type {
  UriParts,
  WorkspaceEntry,
  WorkspaceIdentity,
  WorkspaceOpening,
} from './types';
import {
  LOCATION_ORDER,
  workspaceLocation,
  workspacePresentation,
} from './workspace-presentation';

/**
 * Platform of the Cursor instance that owns the storage.
 * Checked against Cursor 3.23.12 (`2d29876d567da1607532b23bbf2cd5ddbca496f0`):
 * `Ue` is Linux, `j` is macOS, `X` is Windows. That matches VS Code
 * `workspaces.ts` (`Gp` in `out/main.js`). Windows and macOS were not
 * opened on those systems here.
 */
export type OpeningPlatform = 'linux' | 'darwin' | 'win32';

/** Fields Cursor mixes into a local-folder id. Missing stat is not zero. */
export interface OpeningStat {
  /** Linux `stat.ino`. Zero is hashed as an empty salt, matching upstream. */
  ino?: number;
  /** Windows `stat.birthtimeMs` before `Math.floor`. */
  birthtimeMs?: number;
  /** `birthtime.getTime()`. macOS, and Windows when `birthtimeMs` is absent. */
  birthtime?: number;
}

/** Result of one id calculation. `unknown` must not fall back to mtime. */
export type OpeningId =
  | {
      /** Algorithm produced an id. The directory may still be absent. */
      status: 'id';
      /** Lower-hex MD5 Cursor would use for this open. */
      id: string;
    }
  | {
      /** No id. Callers must not invent one. */
      status: 'unknown';
      /** Why the calculation stopped. */
      reason: 'stat-unavailable' | 'untitled' | 'unsupported' | 'missing-uri';
    };

/** Short row label shared by Manage chats, Change workspace, and the sidebar. */
export type StorageMark =
  | 'Current window'
  | 'Opens with this folder'
  | 'Opens with this workspace'
  | 'Other storage'
  | 'Storage not verified';

/** How a workspace list is ordered. Activity is DB/WAL time, not last open. */
export type WorkspaceOrderMode = 'name' | 'activity';

const STAT_PARALLEL = 4;

const NAME_COLLATOR = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
});

/** Map a host platform onto the three Cursor branches. Others stay unknown. */
export function openingPlatform(
  /** `process.platform` of the Cursor UI that owns this profile. */
  platform: NodeJS.Platform,
): OpeningPlatform | undefined {
  if (platform === 'linux' || platform === 'darwin' || platform === 'win32')
    return platform;

  return undefined;
}

/**
 * Filesystem path Cursor hashes for a `file` URI.
 * Windows drive and UNC forms follow `fsPath`. This is not a WHATWG round-trip
 * and does not call `realpath` or change case.
 */
export function cursorFsPath(
  /** Parsed file URI. */
  uri: UriParts,
  /** Platform whose path form is required. */
  platform: OpeningPlatform,
): string {
  if (platform !== 'win32') return uri.path;
  if (uri.authority)
    return `\\\\${uri.authority}${uri.path.replaceAll('/', '\\')}`;

  if (/^\/[A-Za-z]:(?:\/|$)/.test(uri.path)) {
    const drivePath = uri.path.slice(1).replaceAll('/', '\\');

    return drivePath[0].toLowerCase() + drivePath.slice(1);
  }

  return uri.path.replaceAll('/', '\\');
}

/**
 * Compatible workspace-storage id.
 * Local folders hash `fsPath` plus a platform salt with no separator.
 * A missing stat returns `unknown` rather than hashing the path alone.
 * Saved workspaces hash the path, lowercased outside Linux. Remote folders
 * hash the given URI string and do not stat.
 */
export function openingStorageId(input: {
  /** Cursor UI platform for this profile. */
  platform: OpeningPlatform;
  /** Folder window or `.code-workspace` file. */
  kind: 'folder' | 'workspace';
  /** URI scheme. `untitled` is never guessed. */
  scheme: string;
  /** Exact text to hash: `fsPath` or the original URI string. */
  hashed: string;
  /** Local-folder stat. `null` means the stat failed. */
  stat?: OpeningStat | null;
}): OpeningId {
  if (input.scheme === 'untitled')
    return { status: 'unknown', reason: 'untitled' };

  if (input.kind === 'workspace') {
    const text =
      input.platform === 'linux' ? input.hashed : input.hashed.toLowerCase();

    return { status: 'id', id: digest(text) };
  }

  if (input.scheme !== 'file') {
    if (!input.hashed) return { status: 'unknown', reason: 'missing-uri' };

    return { status: 'id', id: digest(input.hashed) };
  }

  if (!input.stat) return { status: 'unknown', reason: 'stat-unavailable' };
  const salt = folderSalt(input.platform, input.stat);

  if (salt === undefined)
    return { status: 'unknown', reason: 'stat-unavailable' };

  return { status: 'id', id: digest(input.hashed, salt) };
}

/**
 * Attach opening facts to a copy of the inventory.
 * One stat per local folder identity. Remote URIs are not statted.
 * A stale caller drops the result; this function stores nothing global.
 */
export async function annotateOpening(
  /** Physical storage rows from one profile listing. */
  entries: WorkspaceEntry[],
  /** Platform, stat, and cancellation for this snapshot. */
  options?: {
    /** Defaults to this process, which is the UI host. */
    platform?: NodeJS.Platform;
    /** Replacement for `fs.promises.stat` in tests. */
    stat?: (file: string) => Promise<OpeningStat>;
    /** Refresh that should not publish. */
    signal?: AbortSignal;
  },
): Promise<WorkspaceEntry[]> {
  const platform = openingPlatform(options?.platform ?? process.platform);
  const read = options?.stat ?? readOpeningStat;
  const groups = new Map<string, WorkspaceEntry[]>();

  for (const entry of entries) {
    const key = workspaceGroupKey(entry);
    const list = groups.get(key);

    if (list) list.push(entry);
    else groups.set(key, [entry]);
  }

  const folderTargets: string[] = [];
  const seenPaths = new Set<string>();

  for (const entry of entries) {
    const file = localFolderPath(entry, platform);

    if (!file || seenPaths.has(file)) continue;
    seenPaths.add(file);
    folderTargets.push(file);
  }

  const stats = new Map<string, OpeningStat | null>();
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < folderTargets.length) {
      if (options?.signal?.aborted) return;
      const file = folderTargets[cursor++];

      if (!file) continue;

      try {
        stats.set(file, await read(file));
      } catch {
        stats.set(file, null);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(STAT_PARALLEL, folderTargets.length) }, () =>
      worker(),
    ),
  );

  if (options?.signal?.aborted) return entries;

  return entries.map((entry) => ({
    ...entry,
    opening: openingForEntry(entry, platform, groups, stats),
  }));
}

/**
 * Storage for startup and Export current workspace.
 * The window's physical database wins. An existing expected id is next.
 * A URI match is not used, including when it is the only match.
 */
export function resolveAutomaticWorkspace(
  /** Annotated inventory for one profile. */
  entries: WorkspaceEntry[],
  /** `state.vscdb` of this window, when the host reports it. */
  currentDatabase: string | undefined,
  /** Identity of the open folder or workspace file. */
  identity: WorkspaceIdentity | undefined,
): WorkspaceEntry | undefined {
  if (currentDatabase) {
    const physical = entries.find((entry) =>
      sameDatabasePath(entry.workspaceDbPath, currentDatabase),
    );

    if (physical) return physical;
  }

  if (!identity) return undefined;
  const want = workspaceKey(identity.kind, identity.uri);

  return entries.find(
    (entry) =>
      entry.identity &&
      workspaceKey(entry.identity.kind, entry.identity.uri) === want &&
      entry.opening?.expectedId === entry.storageId,
  );
}

/**
 * Group, then sort. Expected storage is first inside its group in every mode.
 * A pairwise "expected, else newer" comparison is not transitive, so groups
 * are ordered as wholes and flattened afterward.
 */
export function orderWorkspaceEntries(
  /** Rows to order. The array and its objects are not mutated. */
  entries: WorkspaceEntry[],
  /** Presentation mode and the window used only to pin a group. */
  options: {
    /** Name order, or DB/WAL activity with the current project pinned. */
    mode: WorkspaceOrderMode;
    /** Open identity. Pins that group in activity order. */
    current?: WorkspaceIdentity;
    /** Physical database. Pins its group ahead of the identity fallback. */
    currentDatabase?: string;
  },
): WorkspaceEntry[] {
  const groups = new Map<string, WorkspaceEntry[]>();

  for (const entry of entries) {
    const key = workspaceGroupKey(entry);
    const list = groups.get(key);

    if (list) list.push(entry);
    else groups.set(key, [entry]);
  }

  const ordered = [...groups.values()].map((group) =>
    [...group].sort(compareInsideGroup),
  );

  const pinned =
    options.mode === 'activity'
      ? currentWorkspaceGroupKey(entries, options)
      : undefined;

  ordered.sort((left, right) => {
    if (pinned) {
      const leftPin = workspaceGroupKey(left[0]) === pinned;
      const rightPin = workspaceGroupKey(right[0]) === pinned;

      if (leftPin !== rightPin) return leftPin ? -1 : 1;
    }

    return compareGroups(left, right, options.mode);
  });

  return ordered.flat();
}

/**
 * Identity plus profile. A row without a reliable identity is its own group.
 * Comparators call this only as a key; they do not stat or read JSON.
 */
export function workspaceGroupKey(entry: WorkspaceEntry): string {
  if (!entry.identity)
    return `physical\0${entry.storageRoot}\0${entry.workspaceDbPath}`;

  return `identity\0${entry.storageRoot}\0${workspaceKey(entry.identity.kind, entry.identity.uri)}`;
}

/**
 * Change workspace keeps an empty expected row on screen.
 * Chat count stays a separate statistic and does not remove that row.
 */
export function destinationStaysVisible(
  /** Picker row's storage entry. */
  entry: WorkspaceEntry,
  /** This row is the window's database. */
  isCurrent: boolean,
): boolean {
  return isCurrent || isExpectedStorage(entry);
}

/** True when this database is the one Cursor's algorithm points at. */
export function isExpectedStorage(entry: WorkspaceEntry): boolean {
  return Boolean(
    entry.opening?.expectedId && entry.opening.expectedId === entry.storageId,
  );
}

/**
 * Row label. Current window hides the opening mark; the tooltip keeps both facts.
 * A single row that misses the computed id is still Other storage.
 */
export function storageMark(
  /** Physical row. */
  entry: WorkspaceEntry,
  /** This row is the window's `storageUri` database. */
  isCurrent: boolean,
): StorageMark | undefined {
  if (isCurrent) return 'Current window';
  const opening = entry.opening;
  const known = Boolean(opening?.expectedId);

  if (known && isExpectedStorage(entry)) {
    if (!opening?.duplicate) return undefined;

    return entry.identity?.kind === 'workspace'
      ? 'Opens with this workspace'
      : 'Opens with this folder';
  }

  if (known) return 'Other storage';
  if (opening?.duplicate) return 'Storage not verified';

  return undefined;
}

/** Tooltip sentence for the mark. Folder and workspace wording stay distinct. */
export function storageExplanation(
  /** Physical row. */
  entry: WorkspaceEntry,
  /** This row is the window's database. */
  isCurrent: boolean,
): string | undefined {
  const workspace = entry.identity?.kind === 'workspace';
  const known = Boolean(entry.opening?.expectedId);
  const expected = isExpectedStorage(entry);

  if (isCurrent && known && expected) {
    return workspace
      ? 'This window is using this storage. Cursor also opens this workspace here.'
      : 'This window is using this storage. Cursor also opens this folder here.';
  }

  if (isCurrent && known && !expected) {
    return workspace
      ? 'This window is using this storage. Cursor is expected to open a different storage for this workspace.'
      : 'This window is using this storage. Cursor is expected to open a different storage for this folder.';
  }

  if (!isCurrent && known && expected && entry.opening?.duplicate) {
    return workspace
      ? 'Cursor uses this storage when opening this workspace. Import chats here to access them from this workspace.'
      : 'Cursor uses this storage when opening this folder. Import chats here to access them from this folder.';
  }

  if (!isCurrent && known && !expected) {
    return workspace
      ? 'This storage contains a separate chat history for the same workspace. You can export its chats. Cursor is expected to open a different storage for this workspace.'
      : 'This storage contains a separate chat history for the same folder. You can export its chats. Cursor is expected to open a different storage for this folder.';
  }

  if (!isCurrent && !known && entry.opening?.duplicate) {
    return workspace
      ? 'This workspace has more than one storage, and the one Cursor opens could not be verified.'
      : 'This folder has more than one storage, and the one Cursor opens could not be verified.';
  }

  return undefined;
}

/**
 * Import confirmation when the chosen row is not the existing expected storage.
 * No prompt when the choice already matches, or when the id is unknown.
 */
export function importStoragePrompt(
  /** Destination the user picked. */
  destination: WorkspaceEntry,
  /** Same annotated inventory. */
  entries: WorkspaceEntry[],
):
  | { kind: 'ok' }
  | {
      kind: 'switch';
      /** Physical row of the expected id. */
      expected: WorkspaceEntry;
      /** Button that selects `expected`. */
      useLabel: string;
      /** Modal text. */
      message: string;
    }
  | {
      kind: 'missing';
      /** Modal text. The expected directory is not created. */
      message: string;
    } {
  const expectedId = destination.opening?.expectedId;

  if (!expectedId || expectedId === destination.storageId)
    return { kind: 'ok' };

  const expected = entries.find(
    (entry) =>
      entry.storageId === expectedId &&
      workspaceGroupKey(entry) === workspaceGroupKey(destination),
  );

  const workspace = destination.identity?.kind === 'workspace';

  if (!expected) {
    return {
      kind: 'missing',
      message: workspace
        ? 'Cursor is expected to open a workspace storage that is not in this list. Open the workspace in Cursor and refresh, or import into the selected storage.'
        : 'Cursor is expected to open a folder storage that is not in this list. Open the folder in Cursor and refresh, or import into the selected storage.',
    };
  }

  return {
    kind: 'switch',
    expected,
    useLabel: workspace ? 'Use Workspace Storage' : 'Use Folder Storage',
    message: workspace
      ? 'This storage is not the one Cursor currently selects when opening this workspace. Import into the workspace’s storage instead?'
      : 'This storage is not the one Cursor currently selects when opening this folder. Import into the folder’s storage instead?',
  };
}

/**
 * Re-read before write.
 * Keep agrees to one physical target and one expected id. A changed URI,
 * storage id, root, or expected id stops the import, including unknown to unknown
 * when the identity changed and known to unknown when the facts changed.
 */
export function recheckDestination(
  /** Row confirmed by the user. */
  chosen: WorkspaceEntry,
  /** Fresh read of that same physical target. */
  fresh: WorkspaceEntry[],
  /** User chose Keep Selected Storage. This does not skip the checks below. */
  kept: boolean,
): { status: 'ok'; entry: WorkspaceEntry } | { status: 'stop' } {
  const entry = fresh.find(
    (item) =>
      item.storageRoot === chosen.storageRoot &&
      item.storageId === chosen.storageId &&
      sameDatabasePath(item.workspaceDbPath, chosen.workspaceDbPath),
  );

  if (!entry) return { status: 'stop' };

  const sameIdentity =
    Boolean(chosen.identity) === Boolean(entry.identity) &&
    (!chosen.identity ||
      !entry.identity ||
      workspaceKey(chosen.identity.kind, chosen.identity.uri) ===
        workspaceKey(entry.identity.kind, entry.identity.uri));

  const sameExpected = chosen.opening?.expectedId === entry.opening?.expectedId;

  if (!sameIdentity || !sameExpected || (kept && !sameExpected))
    return { status: 'stop' };

  return { status: 'ok', entry };
}

/** Compare database paths without treating two storages as one project. */
export function sameDatabasePath(left: string, right: string): boolean {
  const normalize = (file: string) =>
    process.platform === 'win32'
      ? path.resolve(file).toLowerCase()
      : path.resolve(file);

  return normalize(left) === normalize(right);
}

/** MD5 of the concatenated parts. SHA-256 would not match Cursor's ids. */
function digest(first: string, second = ''): string {
  return createHash('md5').update(first).update(second).digest('hex');
}

/**
 * Salt text. A falsy number becomes `''`, which is upstream's `s ? String(s) : ''`.
 * A missing field is `undefined` so the caller returns unknown instead of hashing.
 */
function folderSalt(
  platform: OpeningPlatform,
  stat: OpeningStat,
): string | undefined {
  const value =
    platform === 'linux'
      ? finite(stat.ino)
      : platform === 'darwin'
        ? finite(stat.birthtime)
        : typeof stat.birthtimeMs === 'number' &&
            Number.isFinite(stat.birthtimeMs)
          ? Math.floor(stat.birthtimeMs)
          : finite(stat.birthtime);

  if (value === undefined) return undefined;

  return value ? String(value) : '';
}

/** Finite numbers pass through. Anything else is a missing field. */
function finite(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

/** Local file folder path, or undefined when this row must not be statted. */
function localFolderPath(
  entry: WorkspaceEntry,
  platform: OpeningPlatform | undefined,
): string | undefined {
  const identity = entry.identity;

  if (!platform || !identity) return undefined;
  if (identity.kind !== 'folder' || identity.uri.scheme !== 'file')
    return undefined;

  return cursorFsPath(identity.uri, platform);
}

/** Opening facts for one row from the snapshot's shared stat. */
function openingForEntry(
  entry: WorkspaceEntry,
  platform: OpeningPlatform | undefined,
  groups: Map<string, WorkspaceEntry[]>,
  stats: Map<string, OpeningStat | null>,
): WorkspaceOpening {
  const key = workspaceGroupKey(entry);
  const duplicate = (groups.get(key)?.length || 0) > 1;
  const identity = entry.identity;

  if (!platform || !identity) return { duplicate, reason: 'unsupported' };

  if (identity.uri.scheme === 'untitled')
    return { duplicate, reason: 'untitled' };

  if (identity.kind === 'folder' && identity.uri.scheme !== 'file') {
    const id = openingStorageId({
      platform,
      kind: 'folder',
      scheme: identity.uri.scheme,
      hashed: identity.sourceUri || '',
    });

    return id.status === 'id'
      ? { duplicate, expectedId: id.id }
      : { duplicate, reason: id.reason };
  }

  if (identity.kind === 'workspace') {
    const hashed =
      identity.uri.scheme === 'file'
        ? cursorFsPath(identity.uri, platform)
        : identity.sourceUri || '';

    const id = openingStorageId({
      platform,
      kind: 'workspace',
      scheme: identity.uri.scheme,
      hashed,
    });

    return id.status === 'id'
      ? { duplicate, expectedId: id.id }
      : { duplicate, reason: id.reason };
  }

  const stat = stats.get(localFolderPath(entry, platform) || '');

  if (stat === undefined) return { duplicate, reason: 'unsupported' };

  const id = openingStorageId({
    platform,
    kind: 'folder',
    scheme: 'file',
    hashed: cursorFsPath(identity.uri, platform),
    stat,
  });

  return id.status === 'id'
    ? { duplicate, expectedId: id.id }
    : { duplicate, reason: id.reason };
}

/** Activity order pins the current window's group, else the open identity. */
export function currentWorkspaceGroupKey(
  entries: WorkspaceEntry[],
  options: {
    /** Open identity. */
    current?: WorkspaceIdentity;
    /** Physical database. */
    currentDatabase?: string;
  },
): string | undefined {
  if (options.currentDatabase) {
    const physical = entries.find((entry) =>
      sameDatabasePath(entry.workspaceDbPath, options.currentDatabase || ''),
    );

    if (physical) return workspaceGroupKey(physical);
  }

  if (!options.current) return undefined;
  const want = workspaceKey(options.current.kind, options.current.uri);

  const match = entries.find(
    (entry) =>
      entry.identity &&
      workspaceKey(entry.identity.kind, entry.identity.uri) === want,
  );

  return match ? workspaceGroupKey(match) : undefined;
}

/** Expected id, then newer DB/WAL activity, then the database path. */
function compareInsideGroup(
  left: WorkspaceEntry,
  right: WorkspaceEntry,
): number {
  const leftExpected = isExpectedStorage(left) ? 1 : 0;
  const rightExpected = isExpectedStorage(right) ? 1 : 0;

  if (leftExpected !== rightExpected) return rightExpected - leftExpected;

  const recency = validTimestamp(right.mtime) - validTimestamp(left.mtime);

  if (recency) return recency;

  return (
    compareText(left.workspaceDbPath, right.workspaceDbPath) ||
    compareText(left.storageId, right.storageId)
  );
}

/** Name, location, host, then the newest physical row in the group. */
function compareGroups(
  left: WorkspaceEntry[],
  right: WorkspaceEntry[],
  mode: WorkspaceOrderMode,
): number {
  const a = workspacePresentation(left[0]);
  const b = workspacePresentation(right[0]);

  if (mode === 'name') {
    const name = NAME_COLLATOR.compare(a.name, b.name);

    if (name) return name;
  }

  const location =
    LOCATION_ORDER[workspaceLocation(left[0])] -
    LOCATION_ORDER[workspaceLocation(right[0])];

  if (location) return location;

  if (mode === 'name') {
    const host = compareText(
      left[0].identity?.uri.authority || '',
      right[0].identity?.uri.authority || '',
    );

    if (host) return host;
  }

  const freshness = groupFreshness(right) - groupFreshness(left);

  if (freshness) return freshness;

  return compareText(workspaceGroupKey(left[0]), workspaceGroupKey(right[0]));
}

/** Newest finite activity in the group. Invalid times sort as zero. */
function groupFreshness(group: WorkspaceEntry[]): number {
  return group.reduce(
    (max, entry) => Math.max(max, validTimestamp(entry.mtime)),
    0,
  );
}

/** Read birthtime and inode. The caller decides which field the platform uses. */
async function readOpeningStat(file: string): Promise<OpeningStat> {
  const stat = await fs.promises.stat(file);

  return {
    ino: stat.ino,
    birthtimeMs: stat.birthtimeMs,
    birthtime: stat.birthtime.getTime(),
  };
}
