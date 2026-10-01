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
  level: 'INFO' | 'WARN' | 'ERROR',
  text: string,
  date = new Date(),
): string {
  return `[${logTimestamp(date)}] [${level}] ${logSentence(text)}`;
}
