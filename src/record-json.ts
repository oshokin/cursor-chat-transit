import {
  MAX_JSON_DEPTH,
  MAX_JSON_KEYS,
  MAX_JSON_RECORD_BYTES,
} from './bundle-limits';

/** Parse one bounded JSON value and refuse oversized or too-wide objects. */
export function parseBoundedJson(
  bytes: Buffer,
  /** Name used when the value is rejected. */
  label: string,
  /** Property budget for the user payload. The bubble envelope is not charged. */
  maxProperties: number = MAX_JSON_KEYS,
): unknown {
  if (bytes.length > MAX_JSON_RECORD_BYTES) {
    throw coded(
      `${label} is ${bytes.length} bytes; the limit is ${MAX_JSON_RECORD_BYTES}.`,
      'JSON_BYTE_LIMIT',
    );
  }

  let text: string;

  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    throw coded(`${label} is not valid UTF-8.`, 'INVALID_UTF8');
  }

  let value: unknown;

  try {
    value = JSON.parse(text);
  } catch {
    throw coded(`${label} is not valid JSON.`, 'INVALID_JSON');
  }

  assertBoundedRecord(value, label, maxProperties);

  return value;
}

/**
 * Check a transfer record.
 * `{ bubbleId, payload }` counts only `payload` against the property budget.
 */
export function assertBoundedRecord(
  /** JSON value whose size is checked. */
  value: unknown,
  /** Name used when the value is rejected. */
  label: string,
  /** Property budget for the user payload. */
  maxProperties: number = MAX_JSON_KEYS,
): void {
  assertJsonLimits(recordPayload(value), label, maxProperties);
}

/** User payload of a known bubble line, or the value itself. */
function recordPayload(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);

  if (
    keys.length === 2 &&
    keys.includes('bubbleId') &&
    keys.includes('payload') &&
    typeof record.bubbleId === 'string' &&
    record.bubbleId
  )
    return record.payload;

  return value;
}

/** Walk one already-parsed value. Callers must bound the source bytes first. */
export function assertJsonLimits(
  /** JSON value whose size is checked. */
  value: unknown,
  /** Name used when the value is rejected. */
  label: string,
  /** Property budget. Defaults to the built-in record limit. */
  maxProperties: number = MAX_JSON_KEYS,
): void {
  let keys = 0;

  /** Depth-first walk that counts own properties and rejects hostile keys. */
  const visit = (
    /** JSON value at this depth. */
    node: unknown,
    /** Current walk depth. */
    depth: number,
  ): void => {
    if (depth > MAX_JSON_DEPTH) {
      throw coded(
        `${label} is nested deeper than ${MAX_JSON_DEPTH}.`,
        'JSON_DEPTH_LIMIT',
      );
    }

    if (!node || typeof node !== 'object') return;

    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);

      return;
    }

    const proto = Object.getPrototypeOf(node);

    if (proto !== Object.prototype && proto !== null) {
      throw new Error(`${label} contains a non-plain object.`);
    }

    for (const key of Object.keys(node)) {
      keys += 1;

      if (keys > maxProperties) {
        throw coded(
          `${label} has more than ${maxProperties} properties.`,
          'JSON_PROPERTY_LIMIT',
        );
      }

      if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
        throw new Error(`${label} contains a forbidden property name.`);
      }

      visit((node as Record<string, unknown>)[key], depth + 1);
    }
  };

  visit(value, 1);
}

/** Error whose `code` stays distinct from the human-readable limit message. */
function coded(message: string, code: string): Error {
  const error = new Error(message);

  (error as { code?: string }).code = code;

  return error;
}

export { MAX_JSON_RECORD_BYTES };
