/** Evidence retained in the export; never interpreted as a complete conversation. */
export interface TextRecovery {
  /** Version of the deliberately small recovery annotation. */
  version: 1;
  /** Bodies reconstructed from explicitly associated preview text. */
  previews: number;
  /** Missing bodies represented by a labelled gap. */
  gaps: number;
}

/** Build only known-role placeholders. Never guess authorship or replace existing bodies. */
export function recoverMissingMessage(
  composerId: string,
  /** Existing ordered header, not an arbitrary text match. */
  header: Record<string, unknown>,
):
  | {
      /** Bubble payload with recovered text. */
      payload: Record<string, unknown>;
      /** True when the visible text came from a preview. */
      preview: boolean;
    }
  | undefined {
  if (
    typeof header.bubbleId !== 'string' ||
    !header.bubbleId ||
    ![1, 2].includes(header.type as number)
  )
    return undefined;
  const grouping = header.grouping;

  const text =
    grouping && typeof grouping === 'object' && !Array.isArray(grouping)
      ? (grouping as Record<string, unknown>).textPreview
      : undefined;

  const preview = typeof text === 'string' && text.trim().length > 0;

  return {
    preview,
    payload: {
      composerId,
      bubbleId: header.bubbleId,
      type: header.type,
      text: preview
        ? `[Recovered from preview. Full message unavailable.]\n\n${text}`
        : '[Message unavailable in the source. This is a gap in the recovered history.]',
    },
  };
}

/** Accept only the annotation emitted by this exporter; malformed metadata fails closed. */
export function textRecovery(
  /** Bubble payload that may only have preview text. */
  value: unknown,
): TextRecovery | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid text recovery annotation.');
  const row = value as Record<string, unknown>;

  if (
    row.version !== 1 ||
    !Number.isSafeInteger(row.previews) ||
    Number(row.previews) < 0 ||
    !Number.isSafeInteger(row.gaps) ||
    Number(row.gaps) < 0 ||
    Number(row.previews) + Number(row.gaps) === 0
  )
    throw new Error('Invalid text recovery annotation.');

  return row as unknown as TextRecovery;
}
