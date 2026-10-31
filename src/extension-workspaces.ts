import { pickWithStatistics } from './extension-statistics';
import { workspaceStatisticsKey } from './statistics';
import type { TransitLog } from './output-ui';
import path from 'node:path';
import * as vscode from 'vscode';
import { currentIdentity } from './core';
import { setSource } from './extension-state';
import { storageOptions } from './extension-settings';
import * as paths from './paths';
import {
  workspacePickItems,
  workspacePickPlaceholder,
  workspacePickTitle,
  type WorkspacePickAction,
} from './picker';
import type { WorkspaceEntry, WorkspaceIdentity } from './types';
import { workspacePresentation } from './workspace-presentation';
import {
  annotateOpening,
  destinationStaysVisible,
  sameDatabasePath,
} from './workspace-opening';

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
  /** Storage directories from the same pass that have no database. */
  incompleteIds: string[];
}> {
  const scope = hostScope();

  const inventory = await paths.listWorkspaceInventory(scope.userDir, options);

  return {
    ...scope,
    entries: inventory.entries,
    incompleteIds: inventory.incompleteIds,
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
  /** Storage directories from the same pass that have no database. */
  incompleteIds: string[];
}> {
  const listed = await listHostEntriesAsync(options);

  if (options?.signal?.aborted)
    return { ...listed, entries: [], incompleteIds: [] };

  const entries = await annotateOpening(listed.entries, {
    signal: options?.signal,
  });

  if (options?.signal?.aborted)
    return { ...listed, entries: [], incompleteIds: [] };

  return { ...listed, entries };
}

/** Load storage root, workspace entries, and current identity. */
export async function hostState(): Promise<{
  /** Cursor user-data directory that was searched. */
  userDir: string;
  /** Discovered workspace storage pairs. */
  entries: WorkspaceEntry[];
  /** Identity of the workspace open in this window, when it can be read. */
  identity: WorkspaceIdentity | undefined;
}> {
  return loadHostEntries();
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
