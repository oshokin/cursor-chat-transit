import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';

/** File picker filter for `*.zip` exports. */
export const ZIP_FILTER = { 'Cursor chat export': ['zip'] };

/** @deprecated Use ZIP_FILTER. Kept so older call sites fail closed on JSON. */
export const JSON_FILTER = ZIP_FILTER;

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
    filters: ZIP_FILTER,
    openLabel: 'Import',
  };
}

/**
 * Return a local filesystem path for an export.
 * A remote file is copied by the editor; this process does not buffer the archive.
 */
export async function localBundlePath(
  uri: vscode.Uri,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();

  if (uri.scheme === 'file') return uri.fsPath;

  if (uri.scheme !== 'vscode-remote') {
    throw new Error(
      'Choose an export on this computer or the connected remote host.',
    );
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cct-remote-'));
  const dest = path.join(dir, 'import.cursor-chat.zip');

  try {
    signal?.throwIfAborted();

    await vscode.workspace.fs.copy(uri, vscode.Uri.file(dest), {
      overwrite: true,
    });

    signal?.throwIfAborted();

    return dest;
  } catch (error) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);

    throw error;
  }
}
