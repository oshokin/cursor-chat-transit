import * as db from './db';
import { pendingProblem } from './import-bundle-common';
import { cleanUnpublishedBubbles } from './import-cleanup';
import { sha256Text } from './import-policy';
import {
  pendingResourceMatches,
  probeTargetComposer,
} from './import-reconcile';
import { JournalStore } from './journal-db';
import { canvasesDirOf, inspectPair, plansDirOf } from './transfer-context';
import type { TransferContext, WorkspaceEntry } from './types';

/** Finish or repair a journal pending batch against what was stored. */
export async function reconcile(
  /** Receipt database for this destination. */
  journal: JournalStore,
  /** Transfer hooks and cancellation. */
  ctx: TransferContext,
  workspace: WorkspaceEntry,
  /** Open destination databases and their layouts. */
  pair: Awaited<ReturnType<typeof inspectPair>>,
): Promise<() => Promise<void>> {
  const pending = await journal.pending();

  if (!pending) return async () => {};

  const cleanup: typeof cleanUnpublishedBubbles extends (
    /** Argument forwarded to the host. */
    arg: infer T,
  ) => unknown
    ? T[]
    : never = [];

  const chats = await journal.pendingChats(pending.operationId);

  if (!chats.length) return () => journal.clearPending();

  const verified: typeof chats = [];

  for (const chat of chats) {
    const body = await db.readKvText(
      pair.connGl,
      `composerData:${chat.targetComposerId}`,
    );

    if (!body) {
      cleanup.push({
        journal,
        operationId: pending.operationId,
        chat,
        conn: pair.connGl,
        layout: pair.glInfo.layout,
      });

      continue;
    }

    if (sha256Text(body) !== chat.expectedComposerHash) {
      throw pendingProblem(chat.targetComposerId, chat.sourceComposerId);
    }

    const bubbles: Array<[string, string]> = [];

    await journal.forEachBubble(
      pending.operationId,
      chat.targetComposerId,
      (
        id,
        /** Content hash. */
        hash,
      ) => {
        bubbles.push([id, hash]);
      },
    );

    if (
      bubbles.length !== chat.bubbleCount ||
      (await db.listBubbleIds(pair.connGl, chat.targetComposerId)).size !==
        chat.bubbleCount
    ) {
      throw pendingProblem(chat.targetComposerId, chat.sourceComposerId);
    }

    for (const [id, hash] of bubbles) {
      const text = await db.readKvText(
        pair.connGl,
        `bubbleId:${chat.targetComposerId}:${id}`,
      );

      if (!text || sha256Text(text) !== hash) {
        throw pendingProblem(chat.targetComposerId, chat.sourceComposerId);
      }
    }

    const known = await journal.resourcesKnown(
      pending.operationId,
      chat.targetComposerId,
    );

    if (!known) {
      throw pendingProblem(chat.targetComposerId, chat.sourceComposerId);
    }

    const resources: Array<{
      /** Resource class recorded on the pending batch. */
      kind: 'kv' | 'image' | 'plan' | 'canvas';
      /** Resource id recorded on the pending batch. */
      id: string;
      /** SHA-256 recorded on the pending batch. */
      sha256: string;
    }> = [];

    await journal.forEachResource(
      pending.operationId,
      chat.targetComposerId,
      (kind, id, sha256) => {
        if (
          kind === 'kv' ||
          kind === 'image' ||
          kind === 'plan' ||
          kind === 'canvas'
        ) {
          resources.push({ kind, id, sha256 });
        }
      },
    );

    for (const dep of resources) {
      const matches = await pendingResourceMatches(dep, {
        workspace,
        connGl: pair.connGl,
        plansDir: plansDirOf(ctx),
        canvasesDir: canvasesDirOf(ctx, workspace),
      });

      if (!matches) {
        throw pendingProblem(chat.targetComposerId, chat.sourceComposerId);
      }
    }

    const observed = await probeTargetComposer({
      targetComposerId: chat.targetComposerId,
      workspace,
      connWs: pair.connWs,
      connGl: pair.connGl,
      wsInfo: pair.wsInfo.layout,
      glInfo: pair.glInfo.layout,
    });

    if (observed !== 'available') {
      throw pendingProblem(chat.targetComposerId, chat.sourceComposerId);
    }

    verified.push(chat);
  }

  // Preserve verified completed chats while allowing an interrupted later chat to retry.
  for (const chat of verified) {
    await journal.addReceipt({
      sourceComposerId: chat.sourceComposerId,
      snapshotHash: chat.snapshotHash,
      targetComposerId: chat.targetComposerId,
      quality: chat.quality,
    });
  }

  return async () => {
    for (const item of cleanup) await cleanUnpublishedBubbles(item);
    await journal.clearPending();
  };
}
