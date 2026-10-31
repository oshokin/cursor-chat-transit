import { randomUUID } from 'node:crypto';
import {
  assertOrderedReferences,
  bubbleIdsForComposer,
  parseRemappableJson,
  remapJsonObject,
} from './chat-json';
import { assertCanonicalClientRowId } from './client-row-key';
import { remapFamilyRecord } from './chat-family';
import { parseExportResources } from './dependencies';
import { remapConversationStateIds } from './conversation-state';
import { assertExportShape, incompleteComposers } from './format';
import { yieldToHost } from './transfer-context';
import type { ExportObject } from './types';
import { TransferError } from './types';

/** Clone an export with new UUIDs. Missing bodies are errors, never fabricated. */
export async function cloneExportObjectForCopy(
  obj: unknown,
  options?: {
    /** Cancellation for a long clone. */
    signal?: AbortSignal;
    /** Prepared source-to-destination composer ids reused on retry. */
    composerMap?: Map<string, string>;
    /** Prepared compound bubble keys reused on retry. */
    bubbleMap?: Map<string, string>;
  },
): Promise<{
  /** Export object whose composer and bubble ids have been remapped. */
  cloned: ExportObject;
  /** Source composer id to destination composer id. */
  composerMap: Map<string, string>;
  /** Compound source bubble key to destination bubble id. */
  bubbleMap: Map<string, string>;
}> {
  const exportObj = assertExportShape(obj);
  const missing = incompleteComposers(exportObj);

  if (missing.length) {
    const err = new TransferError(
      `Incomplete export: missing composerData for ${missing.length} chat(s).`,
    );

    err.code = 'INCOMPLETE';
    err.missing = missing;

    throw err;
  }

  const resources = parseExportResources(exportObj.resources);
  const composerMap = new Map<string, string>();
  const bubbleMap = new Map<string, string>();
  let steps = 0;

  for (const c of exportObj.allComposers) {
    if (++steps % 32 === 0) await yieldToHost(options?.signal);
    else options?.signal?.throwIfAborted();
    const prepared = options?.composerMap?.get(c.composerId);

    composerMap.set(c.composerId, prepared || randomUUID());
  }

  for (const [oldComposerId, list] of Object.entries(exportObj.bubbles || {})) {
    if (!Array.isArray(list)) {
      const err = new TransferError(
        `Cannot remap bubbles for ${oldComposerId}: unsupported payload.`,
      );

      err.code = 'UNSUPPORTED_BODY';

      throw err;
    }

    const targets = new Set<string>();
    const targetRoots = new Map<string, string>();

    for (const bubble of list) {
      if (++steps % 32 === 0) await yieldToHost(options?.signal);
      else options?.signal?.throwIfAborted();

      if (!bubble || typeof bubble.bubbleId !== 'string' || !bubble.bubbleId) {
        const err = new TransferError('Invalid bubble record');

        err.code = 'UNSUPPORTED_BODY';

        throw err;
      }

      try {
        assertCanonicalClientRowId(bubble.bubbleId);
      } catch (cause) {
        throw Object.assign(new TransferError('Invalid Cursor client-row ID'), {
          code: 'UNSUPPORTED_BODY',
          cause,
        });
      }

      if (bubble.key !== `bubbleId:${oldComposerId}:${bubble.bubbleId}`) {
        const err = new TransferError('Bubble key mismatch');

        err.code = 'UNSUPPORTED_BODY';

        throw err;
      }

      const compound = `${oldComposerId}\0${bubble.bubbleId}`;

      if (bubbleMap.has(compound)) {
        const err = new TransferError('Duplicate bubble key');

        err.code = 'UNSUPPORTED_BODY';

        throw err;
      }

      const parsed = parseRemappableJson(bubble.value, 'bubble');

      if (
        parsed.bubbleId !== undefined &&
        parsed.bubbleId !== bubble.bubbleId
      ) {
        const err = new TransferError('Bubble body ID mismatch');

        err.code = 'UNSUPPORTED_BODY';

        throw err;
      }

      if (
        parsed.composerId !== undefined &&
        parsed.composerId !== oldComposerId
      ) {
        const err = new TransferError('Bubble body ID mismatch');

        err.code = 'UNSUPPORTED_BODY';

        throw err;
      }

      const slash = bubble.bubbleId.indexOf('/');

      const sourceRoot =
        slash < 0 ? bubble.bubbleId : bubble.bubbleId.slice(0, slash);

      if (!targetRoots.has(sourceRoot)) {
        const suffix = slash < 0 ? '' : bubble.bubbleId.slice(slash);
        const prepared = options?.bubbleMap?.get(compound);

        const preparedRoot = options?.bubbleMap?.get(
          `${oldComposerId}\0${sourceRoot}`,
        );

        const nestedRoot =
          prepared && suffix && prepared.endsWith(suffix)
            ? prepared.slice(0, -suffix.length)
            : undefined;

        const targetRoot = preparedRoot || nestedRoot || randomUUID();

        if (targets.has(targetRoot)) {
          throw Object.assign(new TransferError('Duplicate target bubble ID'), {
            code: 'UNSUPPORTED_BODY',
          });
        }

        targetRoots.set(sourceRoot, targetRoot);
        targets.add(targetRoot);
      }

      if (slash < 0) bubbleMap.set(compound, targetRoots.get(sourceRoot)!);
    }

    for (const bubble of list) {
      const slash = bubble.bubbleId.indexOf('/');

      if (slash < 0) continue;
      const compound = `${oldComposerId}\0${bubble.bubbleId}`;
      const sourceRoot = bubble.bubbleId.slice(0, slash);
      const targetRoot = targetRoots.get(sourceRoot)!;
      const target = targetRoot + bubble.bubbleId.slice(slash);
      const prepared = options?.bubbleMap?.get(compound);

      if ((prepared && prepared !== target) || targets.has(target)) {
        throw Object.assign(
          new TransferError('Inconsistent nested target bubble ID'),
          { code: 'UNSUPPORTED_BODY' },
        );
      }

      targets.add(target);
      bubbleMap.set(compound, target);
    }
  }

  const maps = new Map<
    string,
    /** Bubble records keyed by composer id. */
    {
      /** Bubble id map for this composer. */
      bubbles: Map<string, string>;
      /** Composer ids and bubble ids together. */
      all: Map<string, string>;
    }
  >();

  for (const oldId of composerMap.keys()) {
    const bubbles = bubbleIdsForComposer(bubbleMap, oldId);

    maps.set(oldId, { bubbles, all: new Map([...composerMap, ...bubbles]) });
  }

  const cloned: ExportObject = {
    allComposers: [],
    composers: {},
    bubbles: {},
    resources,
  };

  for (const c of exportObj.allComposers) {
    const newId = composerMap.get(c.composerId);

    if (!newId) continue;

    cloned.allComposers.push({
      ...(remapFamilyRecord(
        c as Record<string, unknown>,
        composerMap,
      ) as typeof c),
      composerId: newId,
      workspaceIdentifier: undefined,
    });
  }

  for (const [oldComposerId, list] of Object.entries(exportObj.bubbles || {})) {
    const newComposerId = composerMap.get(oldComposerId);
    const ids = maps.get(oldComposerId);

    if (!newComposerId || !Array.isArray(list) || !cloned.bubbles || !ids)
      continue;
    cloned.bubbles[newComposerId] = [];

    for (const bubble of list) {
      if (++steps % 32 === 0) await yieldToHost(options?.signal);
      else options?.signal?.throwIfAborted();
      const newBubbleId = bubbleMap.get(`${oldComposerId}\0${bubble.bubbleId}`);

      if (!newBubbleId) {
        const err = new TransferError(
          `Cannot remap bubble for ${oldComposerId}: unsupported payload.`,
        );

        err.code = 'UNSUPPORTED_BODY';

        throw err;
      }

      const parsed = parseRemappableJson(
        bubble.value,
        `bubble for ${oldComposerId}`,
      );

      const rewritten = remapFamilyRecord(
        remapJsonObject(parsed, ids.all, ids.bubbles),
        composerMap,
      );

      rewritten.composerId = newComposerId;

      if (rewritten.bubbleId && parsed.bubbleId === bubble.bubbleId) {
        rewritten.bubbleId = newBubbleId;
      }

      cloned.bubbles[newComposerId].push({
        key: `bubbleId:${newComposerId}:${newBubbleId}`,
        value: JSON.stringify(rewritten),
        bubbleId: newBubbleId,
      });
    }
  }

  for (const [oldId, val] of Object.entries(exportObj.composers || {})) {
    if (++steps % 32 === 0) await yieldToHost(options?.signal);
    else options?.signal?.throwIfAborted();
    const newId = composerMap.get(oldId);
    const ids = maps.get(oldId);

    if (!newId || !ids) continue;

    const rewritten = remapFamilyRecord(
      remapJsonObject(
        parseRemappableJson(
          typeof val === 'string' ? val : String(val),
          `composer body for ${oldId}`,
        ),
        ids.all,
        ids.bubbles,
      ),
      composerMap,
    );

    rewritten.conversationState = remapConversationStateIds(
      rewritten.conversationState,
      ids.all,
    );

    rewritten.composerId = newId;

    const available = new Set(
      (cloned.bubbles?.[newId] || []).map((bubble) => bubble.bubbleId),
    );

    assertOrderedReferences(rewritten, available);
    cloned.composers[newId] = JSON.stringify(rewritten);
  }

  return { cloned, composerMap, bubbleMap };
}
