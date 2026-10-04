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
export function config(): {
  /** Local Cursor user-data directory. */
  userDataDir: string;
  /** Absolute path to the sqlite3 executable. */
  sqlitePath: string;
} {
  return {
    userDataDir: localPath('userDataDir'),
    sqlitePath: localPath('sqlitePath'),
  };
}

/** Integer seconds from Settings, validated against the documented range. */
function seconds(
  key: string,
  /** Value used when the input is not finite. */
  fallback: number,
  min: number,
  /** Maximum length after whitespace is collapsed. */
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
  /** URI string or parts. */
  uri: vscode.Uri | undefined,
  /** Name used when the value is rejected. */
  label: string,
): string {
  if (!uri || uri.scheme !== 'file') {
    throw new Error(`${label}: choose a file on this computer.`);
  }

  return uri.fsPath;
}

/** Options for discovering the local Cursor user-data directory. */
export function storageOptions(): {
  /** User-data directory from settings, when set. */
  configuredUserDataDir?: string;
} {
  const { userDataDir } = config();

  return { configuredUserDataDir: userDataDir || undefined };
}

/** Resolve a remembered directory only while it still exists. */
function existingDirectory(
  /** Extension storage and host state. */
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
export function exportDirectory(
  /** Extension storage and host state. */
  context: vscode.ExtensionContext,
): string {
  return existingDirectory(context, LAST_EXPORT_DIR) || os.homedir();
}

/** Last successful local import directory, else the export directory. */
export function importDirectory(
  /** Extension storage and host state. */
  context: vscode.ExtensionContext,
): string {
  return (
    existingDirectory(context, LAST_IMPORT_DIR) || exportDirectory(context)
  );
}

/** Remember a successful local export folder. */
export async function rememberExportDir(
  /** Extension storage and host state. */
  context: vscode.ExtensionContext,
  dest: string,
): Promise<void> {
  await context.globalState.update(LAST_EXPORT_DIR, path.dirname(dest));
}

/** Remember a local import folder only; never store a remote URI as a path. */
export async function rememberImportDir(
  /** Extension storage and host state. */
  context: vscode.ExtensionContext,
  /** URI string or parts. */
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

/** Read-only export recovery preference; repositories cannot change this policy. */
export function recoverTextSetting(): boolean {
  const value = userValue('export.recoverText');

  if (value === undefined) return true;
  if (typeof value !== 'boolean')
    throw new Error(
      'cursorChatTransit.export.recoverText: enter true or false.',
    );

  return value;
}
