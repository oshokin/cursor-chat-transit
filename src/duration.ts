/** Compact duration; exact milliseconds remain available in structured log fields. */
export function humanDuration(
  /** Duration in milliseconds. */
  ms: number,
): string {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (hours) return `${hours}h ${minutes}m ${seconds % 60}s`;
  if (minutes) return `${minutes}m ${seconds % 60}s`;

  return `${seconds}s`;
}

/** Keep the machine-readable value and add the same human duration used by the UI. */
export function durationField(
  name: string,
  /** Duration in milliseconds. */
  ms: number,
): string {
  return `${name}=${ms} (${humanDuration(ms)})`;
}
