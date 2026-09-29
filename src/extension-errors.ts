import * as vscode from 'vscode';
import { setUi } from './extension-state';
import { revealOutput, yieldToHost, type TransitLog } from './output-ui';
import type { TransferError } from './types';

/** Short typed errors for the toast; details stay in the operation log. */
export function userFacingError(err: unknown): string {
  const code = codeOf(err);
  if (code === 'MISSING_DEPENDENCY') {
    return 'Some chat data is missing. Export again from the original Cursor.';
  }
  if (code === 'RESOURCE_CONFLICT') {
    return 'Existing chat data differs. Nothing was overwritten.';
  }
  if (code === 'PARTIAL') {
    return 'The import needs attention. Open the log before continuing.';
  }
  if (code === 'NEEDS_ATTENTION' || code === 'PENDING_IMPORT') {
    return 'The previous import needs checking. No new copies were created.';
  }
  if (code === 'JOURNAL_INVALID') {
    return 'The import journal is unreadable. No chats were changed.';
  }
  if (code === 'LOCK_RECOVERY_REQUIRED') {
    return 'A previous transfer needs attention. Open the operation log for recovery steps.';
  }
  if (code === 'LOCKED') {
    return 'Another Cursor Chat Transit operation is running.';
  }
  if (
    code === 'UNSUPPORTED_STATE' ||
    code === 'UNSUPPORTED_BODY' ||
    code === 'INVALID_RESOURCE'
  ) {
    return 'This file is not a supported Cursor chat export.';
  }
  return err instanceof Error ? err.message : String(err);
}

/** Show a failure in the UI. Recovery details for leftover locks go to the operation log. */
export function showFail(action: string, err: unknown, log?: TransitLog): void {
  console.error(err);
  const message = userFacingError(err);
  const code = codeOf(err);
  if (code === 'LOCK_RECOVERY_REQUIRED' && log) {
    const detail = (err instanceof Error ? err.message : String(err))
      .replace(/[\r\n\t]+/g, ' ')
      .slice(0, 800);
    log.error(detail);
  }
  if (code === 'NEEDS_ATTENTION' && log) {
    const detail =
      err && typeof err === 'object' && 'detail' in err
        ? String((err as TransferError).detail || '')
        : '';
    if (detail) {
      log.error(detail.replace(/[\r\n\t]+/g, ' ').slice(0, 800));
    }
  }
  const needsAttention =
    code === 'NEEDS_ATTENTION' || code === 'PENDING_IMPORT';
  const recovery = code === 'LOCK_RECOVERY_REQUIRED';
  setUi({
    busy: false,
    importNeedsRestart: false,
    status: code === 'PARTIAL' ? 'partial' : 'failed',
    statusTitle: needsAttention
      ? 'The previous import needs checking'
      : recovery
        ? 'A previous transfer needs attention'
        : code === 'PARTIAL'
          ? 'Import partially committed'
          : `${action} failed`,
    statusDetail: message,
    statusItems: [],
  });
  const offerLog = recovery || code === 'PARTIAL' || code === 'NEEDS_ATTENTION';
  if (offerLog && log) {
    void vscode.window.showErrorMessage(message, 'Open log').then((choice) => {
      if (choice === 'Open log') void openLog(log);
    });
    return;
  }
  vscode.window.showErrorMessage(message);
}

/** TransferError.code when present. */
export function codeOf(err: unknown): string | undefined {
  return err && typeof err === 'object' && 'code' in err
    ? String((err as TransferError).code || '') || undefined
    : undefined;
}

/** True when the user or host aborted the operation. */
export function isAbort(err: unknown): boolean {
  return (
    (err instanceof Error && err.name === 'AbortError') ||
    (typeof err === 'object' &&
      err !== null &&
      'name' in err &&
      (err as { name?: string }).name === 'AbortError')
  );
}

/** Select this extension's Output channel; LogOutputChannel.show is a no-op in Cursor. */
export function openLog(channel: TransitLog): Promise<void> {
  return revealOutput(channel, {
    executeCommand: (command) => vscode.commands.executeCommand(command),
    yieldToHost,
  });
}
