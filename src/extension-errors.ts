import { notifyCompletion } from './notifications';
import { formatLogLine } from './log-format';
import * as vscode from 'vscode';
import { setUi } from './extension-state';
import { revealOutput, yieldToHost, type TransitLog } from './output-ui';
import { clearStaleLock, type StaleLock } from './lock';
import type { TransferError } from './types';

/** Lock left by a transfer that died before release. */
let staleLock: StaleLock | undefined;

/** User-requested recovery revalidates the owner immediately before removal. */
export async function recoverStaleTransfer(
  /** Operation log receiving the line. */
  log: TransitLog,
): Promise<void> {
  if (!staleLock) return;
  await clearStaleLock(staleLock);

  log.info(
    `Cleared stale transfer lock path=${JSON.stringify(staleLock.lockPath)}`,
  );

  staleLock = undefined;

  setUi({
    canRecoverLock: false,
    status: 'idle',
    statusTitle: 'Transfer unlocked',
    statusDetail: 'Retry Import or Export. Import journals were preserved.',
  });
}

/** Toast text for a known transfer error. Details stay in the operation log. */
export function userFacingError(err: unknown): string {
  const code = codeOf(err);

  if (code === 'MISSING_MESSAGE' || code === 'NOTHING_TO_IMPORT')
    return 'Required message data is missing. No recovery copy can be created from this archive.';

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
    return 'A previous transfer stopped. Clear its stale lock, then retry.';
  }

  if (code === 'LOCKED') {
    return 'Another Cursor Chat Transit operation is running.';
  }

  if (code === 'FILE_TOO_LARGE') {
    return 'One value in this export is larger than the runtime can hold.';
  }

  if (code === 'INVALID_JSON') {
    return 'This file is not valid JSON.';
  }

  if (err instanceof RangeError && /string length/i.test(err.message)) {
    return 'One value in this export is larger than the runtime can hold.';
  }

  if (code === 'UNSUPPORTED_BODY' || code === 'INVALID_RESOURCE') {
    return 'This file is not a supported Cursor chat export.';
  }

  return err instanceof Error ? err.message : String(err);
}

/** Show a failure in the UI. Recovery details for leftover locks go to the operation log. */
export function showFail(
  /** Which picker step is open. */
  action: string,
  err: unknown,
  /** Operation log receiving the line. */
  log?: TransitLog,
): void {
  const message = userFacingError(err);
  const failure = `${action} failed: ${message}`;

  if (log) log.error(failure);
  else console.error(formatLogLine('ERROR', failure));
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

  staleLock = undefined;

  if (recovery && err && typeof err === 'object' && 'detail' in err) {
    try {
      const data = JSON.parse(String(err.detail));

      if (
        typeof data.lockPath === 'string' &&
        typeof data.token === 'string' &&
        typeof data.pid === 'number'
      )
        staleLock = data;
    } catch {
      /* Ambiguous locks must not be removed. */
    }
  }

  setUi({
    busy: false,
    canRecoverLock: Boolean(staleLock),
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

  if (staleLock && log) {
    notifyCompletion(
      () =>
        vscode.window.showErrorMessage(message, 'Clear stale lock', 'Open log'),
      async (choice) => {
        if (choice === 'Clear stale lock') await recoverStaleTransfer(log);
        if (choice === 'Open log') await openLog(log);
      },
      (error) =>
        log.error(
          `Lock recovery action failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
    );

    return;
  }

  const offerLog = recovery || code === 'PARTIAL' || code === 'NEEDS_ATTENTION';

  if (offerLog && log) {
    notifyCompletion(
      () => vscode.window.showErrorMessage(message, 'Open log'),
      (choice) => {
        if (choice === 'Open log') return openLog(log);
      },
      () =>
        log.warn(
          'Unable to show failure notification or open the operation log.',
        ),
    );

    return;
  }

  notifyCompletion(() => vscode.window.showErrorMessage(message));
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
      (
        err as {
          /** Error name. `AbortError` means cancellation. */
          name?: string;
        }
      ).name === 'AbortError')
  );
}

/** Select this extension's Output channel; LogOutputChannel.show is a no-op in Cursor. */
export function openLog(
  /** Output channel that receives the log. */
  channel: TransitLog,
): Promise<void> {
  return revealOutput(channel, {
    executeCommand: (/** Command id to run. */ command) =>
      vscode.commands.executeCommand(command),
    yieldToHost,
  });
}
