import { pickWithStatistics } from './extension-statistics';
import { workspaceStatisticsKey } from './statistics';
import type { TransitLog } from './output-ui';
import fs from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import { currentIdentity } from './core';
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

/** List local storage entries without requiring sqlite3. */
export function listHostEntries(): {
  /** Cursor user-data directory that was searched. */
  userDir: string;
  /** Discovered workspace storage pairs. */
  entries: WorkspaceEntry[];
  /** Identity of the workspace open in this window, when it can be read. */
  identity: WorkspaceIdentity | undefined;
} {
  const userDir = paths.preferStorageRoot(storageOptions());

  return {
    userDir,
    entries: paths.listWorkspaceEntries(userDir),
    identity: currentIdentity(
      vscode.workspace.workspaceFile,
      vscode.workspace.workspaceFolders,
    ),
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

  return { sqlite, ...listHostEntries() };
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

  const picked = await pickWithStatistics({
    items: workspacePickItems(
      entries,
      current,
      currentWorkspaceDatabase(analysis.context),
    ).flatMap(
      (
        item,
        index,
        /** Full list being walked. */
        items,
      ) => {
        const previous = items[index - 1];

        const group = item.isCurrent
          ? 'Current workspace'
          : workspacePresentation(item.entry).group;

        const previousGroup =
          previous &&
          (previous.isCurrent
            ? 'Current workspace'
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
    keepVisible: (item) => 'isCurrent' in item && item.isCurrent === true,
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
