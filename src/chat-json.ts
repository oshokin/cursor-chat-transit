import { rewriteExactPaths, rewriteObjectKeys } from './core';
import {
  BUBBLE_BODY_POINTERS,
  BUBBLE_KEYED_FIELDS,
  COMPOSER_BODY_POINTERS,
} from './schema';
import { TransferError } from './types';

/** Parse a remappable JSON object; invalid or non-object payloads are errors. */
export function parseRemappableJson(
  /** Text to parse or log. */
  text: unknown,
  /** Name used when the value is rejected. */
  label: string,
): Record<string, unknown> {
  if (typeof text !== 'string') {
    const err = new TransferError(
      `Cannot remap ${label}: unsupported payload.`,
    );

    err.code = 'UNSUPPORTED_BODY';

    throw err;
  }

  try {
    const obj: unknown = JSON.parse(text);

    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      const err = new TransferError(
        `Cannot remap ${label}: unsupported payload.`,
      );

      err.code = 'UNSUPPORTED_BODY';

      throw err;
    }

    return obj as Record<string, unknown>;
  } catch (err) {
    if (err instanceof TransferError) throw err;

    const wrapped = new TransferError(
      `Cannot remap ${label}: unsupported payload.`,
    );

    wrapped.code = 'UNSUPPORTED_BODY';

    throw wrapped;
  }
}

/** Bare bubble-id map for one composer (`composerId\0bubbleId` → new id). */
export function bubbleIdsForComposer(
  /** Composer and bubble id to the new bubble id. */
  bubbleMap: Map<string, string>,
  composerId: string,
): Map<string, string> {
  const prefix = `${composerId}\0`;
  const idMap = new Map<string, string>();

  for (const [compound, mapped] of bubbleMap) {
    if (compound.startsWith(prefix))
      idMap.set(compound.slice(prefix.length), mapped);
  }

  return idMap;
}

/** Ordered headers must point at exported bubbles of this composer. */
export function assertOrderedReferences(
  body: Record<string, unknown>,
  /** Bubble ids present in the export. */
  availableBubbleIds: ReadonlySet<string>,
): void {
  const headers = body.fullConversationHeadersOnly;

  if (headers === undefined) return;

  if (!Array.isArray(headers)) {
    const err = new TransferError('Invalid conversation headers');

    err.code = 'UNSUPPORTED_BODY';

    throw err;
  }

  for (const header of headers) {
    if (!header || typeof header !== 'object' || Array.isArray(header)) {
      const err = new TransferError('Invalid conversation header');

      err.code = 'UNSUPPORTED_BODY';

      throw err;
    }

    const id = (header as Record<string, unknown>).bubbleId;

    if (typeof id !== 'string' || !availableBubbleIds.has(id)) {
      const err = new TransferError('The export is missing message records.');

      err.code = 'UNSUPPORTED_BODY';

      throw err;
    }
  }
}

/** Remap known id fields and nested bubble-keyed objects; leave user text alone. */
export function remapJsonObject(
  obj: Record<string, unknown>,
  /** Old id to the replacement id. */
  idMap: Map<string, string>,
  /** Old bubble id to the new bubble id. */
  bubbleIds: Map<string, string>,
): Record<string, unknown> {
  let next = rewriteExactPaths(
    obj,
    [...COMPOSER_BODY_POINTERS, ...BUBBLE_BODY_POINTERS],
    idMap,
  ) as Record<string, unknown>;

  for (const field of BUBBLE_KEYED_FIELDS) {
    const val = next[field];

    if (!val || typeof val !== 'object' || Array.isArray(val)) continue;
    const keyed = rewriteObjectKeys(val, bubbleIds) as Record<string, unknown>;
    const nested: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(keyed)) {
      nested[key] =
        value && typeof value === 'object' && !Array.isArray(value)
          ? rewriteExactPaths(value, [...BUBBLE_BODY_POINTERS], idMap)
          : value;
    }

    next = { ...next, [field]: nested };
  }

  const headers = next.fullConversationHeadersOnly;

  if (headers !== undefined) {
    if (!Array.isArray(headers)) {
      const err = new TransferError('Invalid conversation headers');

      err.code = 'UNSUPPORTED_BODY';

      throw err;
    }

    next.fullConversationHeadersOnly = headers.map((header: unknown) => {
      if (!header || typeof header !== 'object' || Array.isArray(header)) {
        const err = new TransferError('Invalid conversation header');

        err.code = 'UNSUPPORTED_BODY';

        throw err;
      }

      const rec = header as Record<string, unknown>;
      const old = rec.bubbleId;
      const mapped = typeof old === 'string' ? bubbleIds.get(old) : undefined;

      if (!mapped) {
        const err = new TransferError('The export is missing message records.');

        err.code = 'UNSUPPORTED_BODY';

        throw err;
      }

      return { ...rec, bubbleId: mapped };
    });
  }

  const states = next.originalFileStates;

  if (states && typeof states === 'object' && !Array.isArray(states)) {
    const remapped: Record<string, unknown> = {};

    for (const [uri, state] of Object.entries(states)) {
      remapped[uri] = rewriteExactPaths(
        state,
        ['/firstEditBubbleId'],
        bubbleIds,
      );
    }

    next.originalFileStates = remapped;
  }

  return next;
}
