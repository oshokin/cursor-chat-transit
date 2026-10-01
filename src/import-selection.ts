import {
  classifyTargetObservation,
  decideImport,
  snapshotFingerprint,
  snapshotInputFromChat,
  type Receipt,
} from './import-policy';
import {
  formatTargetObservation,
  needsAttention,
  observeTargetComposer,
} from './import-reconcile';
import type { ImportJournal } from './journal';
import { inspectExportChats, planRecovery } from './recovery';
import {
  canvasesDirOf,
  chatLogLabel,
  inspectPair,
  plansDirOf,
} from './transfer-context';
import type {
  ExportObject,
  ExportResources,
  ImportResult,
  TransferContext,
  WorkspaceEntry,
} from './types';
import { TransferError } from './types';

/** Validate chat quality and decide which snapshots need a new copy. */
export async function selectImportChats(opts: {
  /** Transfer context, including cancellation and operation-log notes. */
  ctx: TransferContext;
  /** Destination workspace whose existing copies are probed. */
  workspace: WorkspaceEntry;
  /** Validated export object being imported. */
  exportObj: ExportObject;
  /** Envelope resources already parsed from the export. */
  resources: ExportResources;
  /** Open connections and detected layouts for both databases. */
  pair: Awaited<ReturnType<typeof inspectPair>>;
  /** When true, recover complete chats and history-only chats from mixed files. */
  allowPartial: boolean;
  /** Journal of verified receipts for this destination. */
  journal: ImportJournal;
  /** Canonical destination identity used to match receipts. */
  targetKey: string;
}) {
  const {
    ctx,
    workspace,
    exportObj,
    resources,
    allowPartial,
    journal,
    targetKey,
  } = opts;

  const { connWs, connGl, wsInfo, glInfo } = opts.pair;

  const inspections = await inspectExportChats({
    exportObj,
    resources,
    conn: connGl,
    workspace,
    signal: ctx.signal,
    plansDir: plansDirOf(ctx),
    canvasesDir: canvasesDirOf(ctx, workspace),
    onProgress: (processed, total) =>
      ctx.onPhase?.('collect', { processed, total }),
  });

  const byId = new Map(
    exportObj.allComposers.map((header) => [header.composerId, header]),
  );

  for (const chat of inspections) {
    const header = byId.get(chat.composerId) || {
      composerId: chat.composerId,
    };

    if (chat.status === 'unusable-chat') {
      ctx.onNote?.(
        `Unreadable chat ${chatLogLabel(header)} reason=${chat.reason}`,
      );
    } else if (chat.status === 'missing-dependencies') {
      ctx.onNote?.(
        `Incomplete chat ${chatLogLabel(header)} missingBlobs=${chat.missingBlobs} missingImages=${chat.missingImages} missingPlans=${chat.missingPlans} missingCanvases=${chat.missingCanvases}`,
      );
    }
  }

  let recovery;

  try {
    recovery = planRecovery(inspections, allowPartial);
  } catch (err) {
    const code = err instanceof Error ? err.message : '';

    if (code === 'INCOMPLETE_IMPORT') {
      const missing = new TransferError(
        'Some chat data is missing. Export again from the original Cursor.',
      );

      missing.code = 'MISSING_DEPENDENCY';

      throw missing;
    }

    if (code === 'NOTHING_TO_IMPORT') {
      const empty = new TransferError('Nothing to import.');

      empty.code = 'NOTHING_TO_IMPORT';

      throw empty;
    }

    throw err;
  }

  const quality = new Map<string, 'complete' | 'history-only'>();

  for (const id of recovery.complete) quality.set(id, 'complete');
  for (const id of recovery.historyOnly) quality.set(id, 'history-only');

  const receipts: Receipt[] = journal.receipts.map((row) => ({
    targetKey,
    sourceComposerId: row.sourceComposerId,
    snapshotHash: row.snapshotHash,
    targetComposerId: row.targetComposerId,
    state: 'verified' as const,
  }));

  if (journal.pending) {
    throw needsAttention(
      'The previous import needs checking. No new copies were created.',
      'pending-import journal still has a pending batch',
    );
  }

  const toCreate: string[] = [];
  const alreadyImportedChats: ImportResult['alreadyImportedChats'] = [];
  const newVersionChats: ImportResult['newVersionChats'] = [];
  const restoredChats: ImportResult['alreadyImportedChats'] = [];
  const snapshotBySource = new Map<string, string>();

  const observations = new Map<
    string,
    Awaited<ReturnType<typeof observeTargetComposer>>
  >();

  /** Read-only probe: workspace list or header-table binding plus body. */
  const probe = async (targetComposerId: string) => {
    const observation = await observeTargetComposer({
      targetComposerId,
      workspace,
      connWs,
      connGl,
      wsInfo: wsInfo.layout,
      glInfo: glInfo.layout,
    });

    observations.set(targetComposerId, observation);

    return classifyTargetObservation(observation);
  };

  for (const sourceId of [...recovery.complete, ...recovery.historyOnly]) {
    observations.clear();
    const header = byId.get(sourceId) || { composerId: sourceId };

    const snapshotHash = snapshotFingerprint(
      snapshotInputFromChat({
        header,
        bodyText: exportObj.composers[sourceId] || '',
        bubbles: exportObj.bubbles?.[sourceId],
        resources,
        quality: quality.get(sourceId) || 'complete',
      }),
    );

    snapshotBySource.set(sourceId, snapshotHash);

    const decision = await decideImport(
      { targetKey, sourceComposerId: sourceId, snapshotHash },
      receipts,
      probe,
    );

    if (decision.action === 'blocked') {
      const facts = [...observations.values()]
        .map(formatTargetObservation)
        .join(' | ');

      throw needsAttention(
        decision.reason === 'pending-import'
          ? 'The previous import needs checking. No new copies were created.'
          : 'An earlier import of this chat is incomplete. No new copies were created.',
        `${decision.reason} source=${sourceId}${facts ? ` ${facts}` : ''}`,
      );
    }

    if (decision.action === 'skip') {
      alreadyImportedChats.push({
        composerId: sourceId,
        name: typeof header.name === 'string' ? header.name : undefined,
        targetComposerId: decision.targetComposerId,
        reason: 'already imported',
      });

      const previous = [...observations.values()]
        .map(formatTargetObservation)
        .join(' | ');

      ctx.onNote?.(
        `Already imported ${chatLogLabel(header)} target=${decision.targetComposerId} reason=same-snapshot${previous ? ` ${previous}` : ''}`,
      );

      continue;
    }

    toCreate.push(sourceId);

    if (decision.reason === 'different-snapshot') {
      newVersionChats.push({
        composerId: sourceId,
        name: typeof header.name === 'string' ? header.name : undefined,
        reason: 'updated version',
      });

      ctx.onNote?.(
        `New version ${chatLogLabel(header)} reason=different-snapshot`,
      );
    } else if (decision.reason === 'deleted-copy') {
      restoredChats.push({
        composerId: sourceId,
        name: typeof header.name === 'string' ? header.name : undefined,
        reason: 'restored copy',
      });

      const previous = [...observations.values()]
        .map(formatTargetObservation)
        .join(' | ');

      ctx.onNote?.(
        `Restored chat ${chatLogLabel(header)} reason=deleted-copy${previous ? ` ${previous}` : ''}`,
      );
    } else {
      ctx.onNote?.(
        `Import new chat ${chatLogLabel(header)} reason=first-import`,
      );
    }
  }

  return {
    recovery,
    quality,
    toCreate,
    alreadyImportedChats,
    newVersionChats,
    restoredChats,
    snapshotBySource,
  };
}
