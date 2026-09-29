import path from 'node:path';
import { parseExportResources } from './dependencies';
import { assertExportShape } from './format';
import { commitImport } from './import-commit';
import { sha256Text } from './import-policy';
import { prepareImport } from './import-prepare';
import { reconcilePending } from './import-reconcile';
import { selectImportChats } from './import-selection';
import { verifyImport } from './import-verify';
import {
  completePendingImport,
  loadJournal,
  saveJournal,
  targetKeyFor,
} from './journal';
import { acquireLock } from './lock';
import { inspectPair, plansDirOf } from './transfer-context';
import type { ImportResult, TransferContext, WorkspaceEntry } from './types';

/** Import a copy of chats into the target workspace after verified backups. */
export async function importFromObject(
  ctx: TransferContext,
  obj: unknown,
  workspace: WorkspaceEntry,
  options?: {
    /** When true, recover complete chats and history-only chats from mixed files. */
    allowPartial?: boolean;
    /** Directory that holds the per-target import journal. */
    journalDir?: string;
    /** Directory that holds the inter-process transfer lock. */
    lockDir?: string;
  },
): Promise<ImportResult> {
  const allowPartial = options?.allowPartial === true;
  const journalDir =
    options?.journalDir ||
    path.join(workspace.storageRoot, 'cursor-chat-transit');
  const lockDir = options?.lockDir || journalDir;
  const targetKey = await targetKeyFor(workspace);
  const lock = await acquireLock(
    lockDir,
    `import-${sha256Text(targetKey).slice(0, 16)}`,
  );
  try {
    return await importWithJournal(ctx, obj, workspace, {
      allowPartial,
      journalDir,
      targetKey,
    });
  } finally {
    await lock.release();
  }
}

/** Import under the journal lock: reconcile, decide copies, commit, verify. */
async function importWithJournal(
  ctx: TransferContext,
  obj: unknown,
  workspace: WorkspaceEntry,
  options: {
    /** When true, recover complete chats and history-only chats from mixed files. */
    allowPartial: boolean;
    /** Directory that holds the per-target import journal. */
    journalDir: string;
    /** Canonical destination identity used to match receipts. */
    targetKey: string;
  },
): Promise<ImportResult> {
  const { allowPartial, journalDir, targetKey } = options;
  ctx.onPhase?.('validate');
  const exportObj = assertExportShape(obj);
  const resources = parseExportResources(exportObj.resources, {
    skipInvalidPayloads: allowPartial,
  });
  const pair = await inspectPair(ctx, workspace);
  const { connWs, connGl, wsInfo, glInfo } = pair;
  if (!glInfo.layout.canWriteGlobal) {
    throw new Error(
      glInfo.layout.unsupportedReason || 'Refusing to write an unknown schema.',
    );
  }
  if (!wsInfo.layout.canWriteWorkspace) {
    throw new Error(
      wsInfo.layout.unsupportedReason ||
        'Refusing to write an unknown workspace schema.',
    );
  }
  let journal = await loadJournal(journalDir, targetKey);
  journal = await reconcilePending(journal, {
    workspace,
    connWs,
    connGl,
    wsInfo: wsInfo.layout,
    glInfo: glInfo.layout,
    plansDir: plansDirOf(ctx),
  });
  await saveJournal(journalDir, journal);
  ctx.onPhase?.('collect');
  const selection = await selectImportChats({
    ctx,
    workspace,
    exportObj,
    resources,
    pair,
    allowPartial,
    journal,
    targetKey,
  });
  const {
    recovery,
    toCreate,
    alreadyImportedChats,
    newVersionChats,
    restoredChats,
  } = selection;
  if (!toCreate.length) {
    return {
      imported: 0,
      complete: 0,
      historyOnly: 0,
      skipped: recovery.skipped.length,
      alreadyImported: alreadyImportedChats.length,
      alreadyPresent: alreadyImportedChats.length,
      newVersions: 0,
      restored: 0,
      incomplete: 0,
      backups: null,
      composerIds: [],
      historyOnlyIds: [],
      skippedChats: recovery.skipped,
      alreadyImportedChats,
      newVersionChats,
      restoredChats,
    };
  }
  const prepared = await prepareImport({
    ctx,
    workspace,
    exportObj,
    resources,
    connGl,
    selection,
  });
  const { cloned, historyOnlyNew, glBackup, wsBackup, pending } = prepared;
  journal = { ...journal, pending };
  await saveJournal(journalDir, journal);

  await commitImport({
    ctx,
    workspace,
    pair,
    prepared,
    onAfterGlobalCommit: async () => {
      const current = journal.pending;
      if (!current) return;
      journal = {
        ...journal,
        pending: { ...current, phase: 'global-written' },
      };
      await saveJournal(journalDir, journal);
    },
    onAfterWorkspaceCommit: async () => {
      const current = journal.pending;
      if (!current) return;
      journal = {
        ...journal,
        pending: { ...current, phase: 'workspace-written' },
      };
      await saveJournal(journalDir, journal);
    },
  });
  const verifyIds = await verifyImport({ ctx, workspace, pair, prepared });
  await saveJournal(journalDir, completePendingImport(journal));
  const writtenComplete = pending.chats.filter(
    (chat) => chat.quality === 'complete',
  ).length;
  const writtenHistory = pending.chats.filter(
    (chat) => chat.quality === 'history-only',
  ).length;
  return {
    imported: cloned.allComposers.length,
    complete: writtenComplete,
    historyOnly: writtenHistory,
    skipped: recovery.skipped.length,
    alreadyImported: alreadyImportedChats.length,
    alreadyPresent: alreadyImportedChats.length,
    newVersions: newVersionChats.length,
    incomplete: 0,
    backups: { global: glBackup, workspace: wsBackup },
    composerIds: verifyIds,
    historyOnlyIds: [...historyOnlyNew],
    skippedChats: recovery.skipped,
    alreadyImportedChats,
    newVersionChats,
    restored: restoredChats.length,
    restoredChats,
  };
}
