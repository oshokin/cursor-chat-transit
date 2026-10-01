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
export async function prepareSqlite(context: vscode.ExtensionContext): Promise<{
  executable: string;
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
  userDir: string;
  entries: WorkspaceEntry[];
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
export async function hostState(context: vscode.ExtensionContext): Promise<{
  sqlite: { executable: string; initFile: string };
  userDir: string;
  entries: WorkspaceEntry[];
  identity: WorkspaceIdentity | undefined;
}> {
  const sqlite = await prepareSqlite(context);

  return { sqlite, ...listHostEntries() };
}

/** QuickPick a workspaceStorage entry; current identity is listed first. */
export async function pickWorkspace(
  entries: WorkspaceEntry[],
  current: WorkspaceIdentity | undefined,
  action: WorkspacePickAction,
): Promise<WorkspaceEntry | undefined> {
  if (!entries.length) {
    throw new Error(
      'No Cursor workspaceStorage databases found in the selected local user-data directory.',
    );
  }

  const pick = await vscode.window.showQuickPick(
    workspacePickItems(entries, current).flatMap((item, index, items) => {
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
    }),
    {
      title: workspacePickTitle(action),
      placeHolder: workspacePickPlaceholder(),
      matchOnDescription: true,
      matchOnDetail: true,
    },
  );

  return pick && 'entry' in pick
    ? (pick as { entry: WorkspaceEntry }).entry
    : undefined;
}
