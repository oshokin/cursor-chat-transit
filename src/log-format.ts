/** Shared presentation caps for names, errors, references, and log fields. */
export const DISPLAY_NAME_CHARS = 120;
/** Maximum user-facing error detail retained in logs. */
export const ERROR_DETAIL_CHARS = 800;
/** Maximum structured free-text field retained in an operation log. */
export const LOG_FIELD_CHARS = 4_096;
/** Default cap for operation log messages. */
export const LOG_MESSAGE_CHARS = 300;
/** Minimum interval between repeated phase log entries. */
export const OPERATION_LOG_HEARTBEAT_MS = 5_000;

/** Human log timestamp: local clock, milliseconds and an explicit UTC offset. */
export function logTimestamp(date = new Date()): string {
  const offset = -date.getTimezoneOffset();

  const local = new Date(date.getTime() + offset * 60_000)
    .toISOString()
    .slice(0, -1)
    .replace('T', ' ');

  const minutes = Math.abs(offset);

  return `${local}${offset < 0 ? '-' : '+'}${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** Single-line sentence case; values and paths retain their original casing. */
export function logSentence(text: string): string {
  const clean = text.replace(/\p{Cc}/gu, ' ').trim();

  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

/** One format for operation events and messages emitted outside a transfer. */
export function formatLogLine(
  /** Log level word. */
  level: 'INFO' | 'WARN' | 'ERROR',
  /** Text to parse or log. */
  text: string,
  date = new Date(),
): string {
  return `[${logTimestamp(date)}] [${level}] ${logSentence(text)}`;
}

/** Quote human-facing fields without JSON-escaping Windows path separators. */
export function logValue(value: string): string {
  const clean = value
    .replace(
      /[\p{Cc}\p{Cf}]/gu,
      (character) =>
        `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
    )
    .replace(/"/g, '\\"');

  return `"${clean}"`;
}
