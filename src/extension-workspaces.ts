import { pickWithStatistics } from './extension-statistics';
import { workspaceStatisticsKey } from './statistics';
import type { TransitLog } from './output-ui';
import fs from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import { currentIdentity } from './core';
import { setSource } from './extension-state';
import { config, storageOptions } from './extension-settings';
import * as paths from './paths';
import {
  workspacePickItems,
  workspacePickPlaceholder,
  workspacePickTitle,
  type WorkspacePickAction,
} from './picker';
import { ensureInitFile, findSqliteExecutable } from './sqlite';
import type { WorkspaceEntry, WorkspaceIdentity } from './types';
import { workspacePresentation } from './workspace-presentation';
import {
  annotateOpening,
  destinationStaysVisible,
  sameDatabasePath,
} from './workspace-opening';

/** Resolve sqlite3 and an empty `-init` file in globalStorage. */
export async function prepareSqlite(
  /** Extension storage and host state. */
  context: vscode.ExtensionContext,
): Promise<{
  /** sqlite3 executable. */
  executable: string;
  /** sqlite3 `-init` file in globalStorage. */
  initFile: string;
}> {
  const { sqlitePath } = config();
  const executable = findSqliteExecutable(sqlitePath || undefined);

  if (!executable) {
    throw new Error(
      'sqlite3 CLI not found. Install sqlite3 locally and/or set cursorChatTransit.sqlitePath.',
    );
  }

  const tmp = path.join(context.globalStorageUri.fsPath, 'sqlite-init');

  await fs.promises.mkdir(tmp, { recursive: true });
  const initFile = await ensureInitFile(tmp);

  return { executable, initFile };
}

/** User-data directory and the identity of this window, without reading storage. */
function hostScope(): {
  /** Cursor user-data directory that was searched. */
  userDir: string;
  /** Identity of the workspace open in this window, when it can be read. */
  identity: WorkspaceIdentity | undefined;
} {
  return {
    userDir: paths.preferStorageRoot(storageOptions()),
    identity: currentIdentity(
      vscode.workspace.workspaceFile,
      vscode.workspace.workspaceFolders,
    ),
  };
}

/**
 * Synchronous inventory for a low-level task that does not need opening facts.
 * UI routes use `listHostEntriesAsync`.
 */
export function listHostEntries(): {
  /** Cursor user-data directory that was searched. */
  userDir: string;
  /** Discovered workspace storage pairs. */
  entries: WorkspaceEntry[];
  /** Identity of the workspace open in this window, when it can be read. */
  identity: WorkspaceIdentity | undefined;
} {
  const scope = hostScope();

  return {
    ...scope,
    entries: paths.listWorkspaceEntries(scope.userDir),
  };
}

/** Profile inventory with bounded metadata reads. A cancelled snapshot is empty. */
export async function listHostEntriesAsync(options?: {
  /** Refresh that must not publish this snapshot. */
  signal?: AbortSignal;
}): Promise<{
  /** Cursor user-data directory that was searched. */
  userDir: string;
  /** Discovered workspace storage pairs. */
  entries: WorkspaceEntry[];
  /** Identity of the workspace open in this window, when it can be read. */
  identity: WorkspaceIdentity | undefined;
}> {
  const scope = hostScope();

  return {
    ...scope,
    entries: await paths.listWorkspaceEntriesAsync(scope.userDir, options),
  };
}

/**
 * One prepared inventory for Change, startup, import, export, and Manage chats.
 * Opening facts are attached once. SQLite is not required for this step.
 */
export async function loadHostEntries(options?: {
  /** Refresh that should not publish this snapshot. */
  signal?: AbortSignal;
}): Promise<{
  /** Cursor user-data directory that was searched. */
  userDir: string;
  /** Physical entries with opening facts for this snapshot. */
  entries: WorkspaceEntry[];
  /** Identity of the workspace open in this window, when it can be read. */
  identity: WorkspaceIdentity | undefined;
}> {
  const listed = await listHostEntriesAsync(options);

  if (options?.signal?.aborted) return { ...listed, entries: [] };

  return {
    userDir: listed.userDir,
    identity: listed.identity,
    entries: await annotateOpening(listed.entries, { signal: options?.signal }),
  };
}

/** Load sqlite, storage root, workspace entries, and current identity. */
export async function hostState(
  /** Extension storage and host state. */
  context: vscode.ExtensionContext,
): Promise<{
  /** sqlite3 executable and init file. */
  /** Path of the sqlite3 executable. */
  sqlite: {
    /** sqlite3 executable chosen for this host. */
    executable: string;
    /** SQLite init file passed to that executable. */
    initFile: string;
  };
  /** Cursor user-data directory that was searched. */
  userDir: string;
  /** Discovered workspace storage pairs. */
  entries: WorkspaceEntry[];
  /** Identity of the workspace open in this window, when it can be read. */
  identity: WorkspaceIdentity | undefined;
}> {
  const sqlite = await prepareSqlite(context);
  const listed = await loadHostEntries();

  return { sqlite, ...listed };
}

/**
 * Remember the selected storage and mark Current window only for this window's database.
 * A later selection of another storage clears that mark.
 */
export function rememberSource(
  /** Extension storage used to read this window's database path. */
  context: vscode.ExtensionContext,
  /** Selected workspace, or none. */
  entry: WorkspaceEntry | undefined,
): void {
  if (!entry) {
    setSource(undefined);

    return;
  }

  const database = currentWorkspaceDatabase(context);

  setSource(entry, {
    currentWindow: Boolean(
      database && sameDatabasePath(entry.workspaceDbPath, database),
    ),
  });
}

/** Local physical workspace database reported by the host, including profile isolation. */
export function currentWorkspaceDatabase(
  /** Extension storage and host state. */
  context: vscode.ExtensionContext,
): string | undefined {
  return context.storageUri?.scheme === 'file'
    ? path.join(path.dirname(context.storageUri.fsPath), 'state.vscdb')
    : undefined;
}

/** QuickPick a workspaceStorage entry; current identity is listed first. */
export async function pickWorkspace(
  /** Entries to turn into picker rows. */
  entries: WorkspaceEntry[],
  /** Identity of the workspace that is open now. */
  current: WorkspaceIdentity | undefined,
  /** Which picker step is open. */
  action: WorkspacePickAction,
  /** Extension storage and host state. */
  analysis: {
    /** Extension storage passed into the picker. */
    context: vscode.ExtensionContext;
    /** Output channel that receives picker notes. */
    operations: TransitLog;
  },
): Promise<WorkspaceEntry | undefined> {
  if (!entries.length) {
    throw new Error(
      'No Cursor workspaces found. Check the user-data directory.',
    );
  }

  const rows = workspacePickItems(
    entries,
    current,
    currentWorkspaceDatabase(analysis.context),
  );

  const currentProject = rows.filter((item) => item.inCurrentGroup).length > 1;

  const picked = await pickWithStatistics({
    items: rows.flatMap(
      (
        item,
        index,
        /** Full list being walked. */
        items,
      ) => {
        const previous = items[index - 1];

        const group = item.inCurrentGroup
          ? currentProject
            ? 'Current project'
            : 'Current workspace'
          : workspacePresentation(item.entry).group;

        const previousGroup =
          previous &&
          (previous.inCurrentGroup
            ? currentProject
              ? 'Current project'
              : 'Current workspace'
            : workspacePresentation(previous.entry).group);

        return group === previousGroup
          ? [item]
          : [
              {
                label: group,
                kind: vscode.QuickPickItemKind.Separator,
              } as vscode.QuickPickItem,
              item,
            ];
      },
    ),
    title: workspacePickTitle(action),
    placeholder: workspacePickPlaceholder(),
    key: (item) =>
      'entry' in item
        ? workspaceStatisticsKey(
            (
              item as {
                /** Workspace the user picked. */
                entry: WorkspaceEntry;
              }
            ).entry,
          )
        : undefined,
    keepVisible: (item) =>
      'entry' in item &&
      destinationStaysVisible(
        (
          item as {
            /** Workspace the user picked. */
            entry: WorkspaceEntry;
          }
        ).entry,
        'isCurrent' in item && item.isCurrent === true,
      ),
    buttonLabel: 'Count chats in each workspace',
    operations: analysis.operations,
    job: async () => ({
      ...(await prepareSqlite(analysis.context)),
      kind: 'workspace-statistics',
      workspaces: entries,
    }),
  });

  const pick = picked?.[0];

  return pick && 'entry' in pick
    ? (
        pick as {
          /** Workspace the user picked. */
          entry: WorkspaceEntry;
        }
      ).entry
    : undefined;
}
