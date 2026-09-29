import * as vscode from 'vscode';
import { readJsonFile } from './format';

/** File picker filter for `*.json` exports. */
export const JSON_FILTER = { JSON: ['json'] };
/** Ceiling for a provider-buffered remote read; larger files are refused before parse. */
export const MAX_REMOTE_EXPORT_BYTES = 512 * 1024 * 1024;

/** Local default is independent of the selected chat's workspace scheme. */
export function importDialogOptions(
  localDirectory: string,
): vscode.OpenDialogOptions {
  return {
    title: 'Import Cursor chats',
    defaultUri: vscode.Uri.file(localDirectory),
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    filters: JSON_FILTER,
    openLabel: 'Import',
  };
}

/** Remote URI is read through its provider, never converted to a local fsPath. */
export async function readExportUri(
  uri: vscode.Uri,
  signal?: AbortSignal,
): Promise<unknown> {
  signal?.throwIfAborted();
  if (uri.scheme === 'file') return readJsonFile(uri.fsPath, signal);
  if (uri.scheme !== 'vscode-remote')
    throw new Error(
      'Choose a JSON file on this computer or the connected remote host.',
    );
  const stat = await vscode.workspace.fs.stat(uri);
  signal?.throwIfAborted();
  if (
    !(stat.type & vscode.FileType.File) ||
    stat.size > MAX_REMOTE_EXPORT_BYTES
  ) {
    throw new Error('Choose a JSON file no larger than 512 MiB.');
  }
  // workspace.fs.readFile has no CancellationToken overload. Cancellation is checked on return.
  const bytes = await vscode.workspace.fs.readFile(uri);
  signal?.throwIfAborted();
  if (bytes.byteLength > MAX_REMOTE_EXPORT_BYTES)
    throw new Error('The JSON file exceeds 512 MiB.');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}
