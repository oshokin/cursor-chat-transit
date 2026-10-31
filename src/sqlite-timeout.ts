import { logValue } from './log-format';
import { humanDuration } from './duration';

/** Largest parent-side deadline accepted from the SQLite worker protocol. */
export const SQLITE_SUPERVISOR_MAX_TIMEOUT_MS = 60 * 60 * 1_000;

/** Cooperative cancellation window before the SQLite worker is killed. */
export const SQLITE_SUPERVISOR_CANCEL_GRACE_MS = 2_000;

/** A deadline is distinct from SQLITE_BUSY and from user cancellation. */
export function sqliteTimeoutError(
  /** Deadline for one SQLite request, in milliseconds. */
  timeoutMs: number,
  database?: string,
): Error & {
  /** Always `SQLITE_TIMEOUT`. */
  code: string;
} {
  return Object.assign(
    new Error(
      `SQLite operation timed out after ${timeoutMs} ms (${humanDuration(timeoutMs)})${database ? ` for ${logValue(database)}` : ''}. Adjust cursorChatTransit.sqlite.operationTimeoutSeconds for the next transfer.`,
    ),
    { code: 'SQLITE_TIMEOUT' },
  );
}
