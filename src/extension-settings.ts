import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';

/** GlobalState key for the last successful local export folder. */
export const LAST_EXPORT_DIR = 'lastExportDir';

/** GlobalState key for the last successful local import folder. */
export const LAST_IMPORT_DIR = 'lastImportDir';

/** Only explicit user values: a repository cannot redirect paths or enable recovery. */
function userValue(key: string): unknown {
  return vscode.workspace.getConfiguration('cursorChatTransit').inspect(key)
    ?.globalValue;
}

/** Absolute user-setting path, or empty when unset. */
function localPath(key: string): string {
  const raw = userValue(key);

  if (raw === undefined || raw === '') return '';

  if (
    typeof raw !== 'string' ||
    !path.isAbsolute(raw) ||
    /[\0\r\n]/u.test(raw)
  ) {
    throw new Error(
      `cursorChatTransit.${key}: enter an absolute path on this computer.`,
    );
  }

  return raw;
}

/** Read local path settings without discarding a valid user value when a workspace overrides it. */
export function config(): { userDataDir: string; sqlitePath: string } {
  return {
    userDataDir: localPath('userDataDir'),
    sqlitePath: localPath('sqlitePath'),
  };
}

/** Integer seconds from Settings, clamped to the documented range. */
function seconds(
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = userValue(key);

  if (raw === undefined) return fallback;

  if (
    typeof raw !== 'number' ||
    !Number.isInteger(raw) ||
    raw < min ||
    raw > max
  ) {
    throw new Error(
      `cursorChatTransit.${key}: enter a whole number from ${min} to ${max}.`,
    );
  }

  return raw;
}

/** Snapshot once per operation; changes in Settings affect the next transfer. */
export function transferSettings(): {
  /** Deadline for each query or session request. */
  timeoutMs: number;
  /** Busy-handler wait for supported lock contention. */
  busyTimeoutMs: number;
  /** Absolute plans directory from the user setting, when set. */
  plansDir?: string;
} {
  return {
    timeoutMs: seconds('sqlite.operationTimeoutSeconds', 600, 30, 3600) * 1000,
    busyTimeoutMs: seconds('sqlite.busyTimeoutSeconds', 5, 0, 30) * 1000,
    plansDir: localPath('plansDirectory') || undefined,
  };
}

/** Require a local `file:` URI and return its fsPath. */
export function requireLocalFile(
  uri: vscode.Uri | undefined,
  label: string,
): string {
  if (!uri || uri.scheme !== 'file') {
    throw new Error(`${label}: choose a file on this computer.`);
  }

  return uri.fsPath;
}

/** Options for discovering the local Cursor user-data directory. */
export function storageOptions(): { configuredUserDataDir?: string } {
  const { userDataDir } = config();

  return { configuredUserDataDir: userDataDir || undefined };
}

/** Resolve a remembered directory only while it still exists. */
function existingDirectory(
  context: vscode.ExtensionContext,
  key: string,
): string | undefined {
  const last = context.globalState.get<string>(key);

  if (!last) return undefined;

  try {
    return fs.statSync(last).isDirectory() ? last : undefined;
  } catch {
    return undefined;
  }
}

/** Last successful local export directory, else home. */
export function exportDirectory(context: vscode.ExtensionContext): string {
  return existingDirectory(context, LAST_EXPORT_DIR) || os.homedir();
}

/** Last successful local import directory, else the export directory. */
export function importDirectory(context: vscode.ExtensionContext): string {
  return (
    existingDirectory(context, LAST_IMPORT_DIR) || exportDirectory(context)
  );
}

/** Remember a successful local export folder. */
export async function rememberExportDir(
  context: vscode.ExtensionContext,
  dest: string,
): Promise<void> {
  await context.globalState.update(LAST_EXPORT_DIR, path.dirname(dest));
}

/** Remember a local import folder only; never store a remote URI as a path. */
export async function rememberImportDir(
  context: vscode.ExtensionContext,
  uri: vscode.Uri,
): Promise<void> {
  if (uri.scheme !== 'file') return;
  await context.globalState.update(LAST_IMPORT_DIR, path.dirname(uri.fsPath));
}

/** Operation-log threshold. Unknown values stay at `info`. */
export type OperationLogLevel = 'info' | 'warn' | 'error';

/** User/application log level. A workspace value cannot hide import failures. */
export function operationLogLevel(): OperationLogLevel {
  const raw = userValue('logLevel');

  if (raw === 'info' || raw === 'warn' || raw === 'error') return raw;

  return 'info';
}

/** User/application setting only; workspace cannot silently enable recovery. */
export function importAllowPartial(): boolean {
  const inspect = vscode.workspace
    .getConfiguration('cursorChatTransit')
    .inspect<boolean>('import.allowPartial');

  return inspect?.globalValue === true;
}
