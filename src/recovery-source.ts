/** A bounded-to-one-chat source check; payloads are never retained. */
export class RecoverySourceCheck {
  /** Ordered message ids and their expected roles. */
  private readonly expected = new Map<string, number>();
  /** Duplicate records or unknown shapes fail closed. */
  private valid = true;
  /** Whether there is a nonempty, recognized conversation. */
  private readonly hasMessages: boolean;

  /** Capture the supported conversation shape while the exporter is already reading it. */
  constructor(
    /** Source composer identity. */
    private readonly composerId: string,
    /** Composer fields already parsed for this export. */
    fields: Record<string, unknown>,
    /** Ordered conversation headers from the composer body. */
    items: unknown[],
    /** True when that body has a supported conversation state. */
    present: boolean,
  ) {
    this.hasMessages = present && items.length > 0;
    if (fields.composerId !== undefined && fields.composerId !== composerId)
      this.valid = false;

    for (const item of items) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        this.valid = false;
        continue;
      }

      const row = item as Record<string, unknown>;

      if (
        typeof row.bubbleId !== 'string' ||
        (row.type !== undefined && ![1, 2].includes(row.type as number))
      ) {
        this.valid = false;
        continue;
      }

      const previous = this.expected.get(row.bubbleId);

      if (previous !== undefined && previous !== (row.type ?? 0))
        this.valid = false;
      this.expected.set(row.bubbleId, (row.type as number | undefined) ?? 0);
    }
  }

  /** Validate a message already read by export, retaining no body bytes. */
  bubble(
    /** Bubble id the exporter just read. */
    id: string,
    /** Parsed bubble payload. The body is not retained. */
    payload: unknown,
  ): void {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      this.valid = false;

      return;
    }

    const row = payload as Record<string, unknown>;

    if (
      (row.bubbleId !== undefined && row.bubbleId !== id) ||
      (row.composerId !== undefined && row.composerId !== this.composerId)
    )
      this.valid = false;
    const expected = this.expected.get(id);

    if (
      expected !== undefined &&
      expected !== 0 &&
      row.type !== undefined &&
      row.type !== expected
    )
      this.valid = false;
    this.expected.delete(id);
  }

  /** Destination preflight still checks dependencies, receipts and write compatibility. */
  get candidate(): boolean {
    return this.valid && this.hasMessages && this.expected.size === 0;
  }
}
