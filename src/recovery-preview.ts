/** Small preflight result. Message bodies never cross the worker boundary. */
export interface RecoveryPreview {
  /** Chats that can be imported with their resources. */
  complete: number;
  /** Chats imported without optional resources. */
  historyOnly: number;
  /** Chats that cannot be imported. */
  skipped: number;
  /** Chats already present at the same snapshot. */
  alreadyImported: number;
  /** Missing resource counts keyed by kind. */
  missingResources: Record<string, number>;
  /** At most five examples; all skipped chats are recorded in Operations. */
  details: string[];
}

/** Explain losses before offering an operation-specific decision. */
export function recoveryDetail(
  /** Counts and examples from import preflight. */
  preview: RecoveryPreview,
): string {
  const resources = Object.entries(preview.missingResources)
    .map(
      (/** Resource kind and how many are missing. */ [kind, count]) =>
        `${count} ${{ kv: 'agent data records', image: 'images', plan: 'plans', canvas: 'canvases' }[kind] || kind}`,
    )
    .join(', ');

  return [
    `${preview.complete} complete · ${preview.historyOnly} history only · ${preview.skipped} cannot be imported · ${preview.alreadyImported} already imported`,
    resources ? `Missing: ${resources}.` : '',
    'Existing chats are kept. Recovered previews and gaps are labelled; missing original text cannot be recreated. Cursor may not allow recovered chats to continue.',
    ...preview.details,
    preview.skipped > preview.details.length
      ? 'More details are in the operation log.'
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}
