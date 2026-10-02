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
export async function prepareSqlite(context: vscode.ExtensionContext): Promise<{
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
export async function hostState(context: vscode.ExtensionContext): Promise<{
  /** sqlite3 executable and init file. */
  sqlite: { executable: string; initFile: string };
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

/** QuickPick a workspaceStorage entry; current identity is listed first. */
export async function pickWorkspace(
  entries: WorkspaceEntry[],
  current: WorkspaceIdentity | undefined,
  action: WorkspacePickAction,
  analysis: { context: vscode.ExtensionContext; operations: TransitLog },
): Promise<WorkspaceEntry | undefined> {
  if (!entries.length) {
    throw new Error(
      'No Cursor workspaceStorage databases found in the selected local user-data directory.',
    );
  }

  const picked = await pickWithStatistics({
    items: workspacePickItems(
      entries,
      current,
      analysis.context.storageUri?.scheme === 'file'
        ? path.join(
            path.dirname(analysis.context.storageUri.fsPath),
            'state.vscdb',
          )
        : undefined,
    ).flatMap((item, index, items) => {
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
    title: workspacePickTitle(action),
    placeholder: workspacePickPlaceholder(),
    key: (item) =>
      'entry' in item
        ? workspaceStatisticsKey((item as { entry: WorkspaceEntry }).entry)
        : undefined,
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
    ? (pick as { entry: WorkspaceEntry }).entry
    : undefined;
}
