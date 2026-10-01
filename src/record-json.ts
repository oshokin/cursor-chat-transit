import {
  MAX_JSON_DEPTH,
  MAX_JSON_KEYS,
  MAX_JSON_RECORD_BYTES,
} from './bundle-limits';

/** Parse one bounded JSON value and refuse oversized or too-wide objects. */
export function parseBoundedJson(bytes: Buffer, label: string): unknown {
  if (bytes.length > MAX_JSON_RECORD_BYTES) {
    throw new Error(
      `${label} is ${bytes.length} bytes; the limit is ${MAX_JSON_RECORD_BYTES}.`,
    );
  }

  let text: string;

  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    throw new Error(`${label} is not valid UTF-8.`);
  }

  let value: unknown;

  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }

  assertJsonLimits(value, label);

  return value;
}

/** Walk one already-parsed value. Callers must bound the source bytes first. */
export function assertJsonLimits(value: unknown, label: string): void {
  let keys = 0;

  /** Depth-first walk that counts own properties and rejects hostile keys. */
  const visit = (node: unknown, depth: number): void => {
    if (depth > MAX_JSON_DEPTH) {
      throw new Error(`${label} is nested deeper than ${MAX_JSON_DEPTH}.`);
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

      if (keys > MAX_JSON_KEYS) {
        throw new Error(`${label} has more than ${MAX_JSON_KEYS} properties.`);
      }

      if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
        throw new Error(`${label} contains a forbidden property name.`);
      }

      visit((node as Record<string, unknown>)[key], depth + 1);
    }
  };

  visit(value, 1);
}

export { MAX_JSON_RECORD_BYTES };
