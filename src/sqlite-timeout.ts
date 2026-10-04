import { humanDuration } from './duration';

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
      `SQLite operation timed out after ${timeoutMs} ms (${humanDuration(timeoutMs)})${database ? ` for ${JSON.stringify(database)}` : ''}. Adjust cursorChatTransit.sqlite.operationTimeoutSeconds for the next transfer.`,
    ),
    { code: 'SQLITE_TIMEOUT' },
  );
}
