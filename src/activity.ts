import type { ComposerHeader } from './types';

/** Cursor header times are milliseconds. Do not guess units or derive dates from IDs. */
export function validTimestamp(
  /** Header time field. */
  value: unknown,
): number {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= 8.64e15
    ? value
    : 0;
}

/** Recency for sort: lastUpdatedAt, else createdAt. IDs are never treated as dates. */
export function chatActivity(header: ComposerHeader): number {
  return (
    validTimestamp(header.lastUpdatedAt) || validTimestamp(header.createdAt)
  );
}

/** Stable tie-breaker independent of filesystem/SQL iteration order. */
export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Sort a copy; presentation must not rewrite exported metadata or database order. */
export function recentChats(headers: ComposerHeader[]): ComposerHeader[] {
  return [...headers].sort(
    (a, b) =>
      chatActivity(b) - chatActivity(a) ||
      validTimestamp(b.createdAt) - validTimestamp(a.createdAt) ||
      compareText(a.composerId, b.composerId),
  );
}

/** Reuse Intl formatting across large header lists. Locale is fixed for this host session. */
const activityFormatter = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

/** Absolute local dates remain unambiguous across midnight and long sessions. */
export function chatActivityLabel(header: ComposerHeader): string {
  const timestamp = chatActivity(header);

  if (!timestamp) return 'Date unavailable';

  const date = activityFormatter.format(timestamp);

  return `${validTimestamp(header.lastUpdatedAt) ? 'Updated' : 'Created'} ${date}`;
}
