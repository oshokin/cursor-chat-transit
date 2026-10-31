import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { ordinalName } from './bundle-names';
import { openBundle } from './bundle-reader';
import {
  asObject,
  oneChat,
  recoveryPreview,
  resultFrom,
} from './import-bundle-common';
import {
  projectImportedModel,
  reconcilePendingProjection,
  writeOne,
} from './import-bundle-publish';
import { reconcile } from './import-bundle-reconcile';
import { isPreflightKvConflict } from './import-bundle-resources';
import { scanAll } from './import-bundle-scan';
import { hashFile } from './hash-file';
import {
  publishHostSnapshot,
  userDataDirFromGlobalDb,
  validateHostSnapshot,
} from './host-snapshots';
import { assertStoredListsReadable } from './import-reconcile';
import { targetKeyFor } from './journal';
import { JournalStore } from './journal-db';
import { acquireLock } from './lock';
import { parseBoundedJson } from './record-json';
import type { RecoveryPreview } from './recovery-preview';
import { SqliteSession } from './sqlite-session';
import { readFile } from './trace-fs';
import { canvasesDirOf, inspectPair, plansDirOf } from './transfer-context';
import { inChat } from './transfer-events';
import type { ImportResult, TransferContext, WorkspaceEntry } from './types';
import { TransferError } from './types';

/** Import a v4 archive. JSON exports from older builds are rejected. */
export async function importFromBundle(
  /** Transfer hooks, timeouts, and cancellation. */
  ctx: TransferContext,
  /** Path of the v4 archive. */
  zipPath: string,
  workspace: WorkspaceEntry,
  options?: {
    /** When true, import chats that are missing optional resources. */
    allowPartial?: boolean;
    /** Ask once after inspection, before changing Cursor data. */
    onRecovery?: (
      /** Counts and examples; no message bodies. */
      preview: RecoveryPreview,
    ) => Promise<boolean>;
    /** Also review complete sources when explicitly recovering a copy. */
    confirmCopy?: boolean;
    /** Directory for the v4 receipt database. */
    journalDir?: string;
    /** Directory for the transfer lock. */
    lockDir?: string;
  },
): Promise<ImportResult> {
  const journalDir =
    options?.journalDir ||
    path.join(workspace.storageRoot, 'cursor-chat-transit');

  const targetKey = await targetKeyFor(workspace);

  const lock = await acquireLock(
    options?.lockDir ||
      path.join(
        path.dirname(workspace.globalDbPath),
        'cursor-chat-transit-locks',
      ),
    'import-global',
  );

  try {
    return await runImport(ctx, zipPath, workspace, {
      allowPartial: options?.allowPartial === true,
      journalDir,
      targetKey,
      onRecovery: options?.onRecovery,
      confirmCopy: options?.confirmCopy,
    });
  } finally {
    await lock.release();
  }
}

/** Unpack the bundle, scan chats, then write the ones the policy accepts. */
export async function runImport(
  /** Transfer hooks, timeouts, and cancellation. */
  ctx: TransferContext,
  /** Path of the v4 archive. */
  zipPath: string,
  workspace: WorkspaceEntry,
  options: {
    /** When true, keep readable history from an incomplete export. */
    allowPartial: boolean;
    /** Ask once after inspection, before changing Cursor data. */
    onRecovery?: (
      /** Counts and examples; no message bodies. */
      preview: RecoveryPreview,
    ) => Promise<boolean>;
    /** Also review complete sources when explicitly recovering a copy. */
    confirmCopy?: boolean;
    /** Directory that holds the private journal database. */
    journalDir: string;
    /** Canonical target identity for that journal. */
    targetKey: string;
  },
): Promise<ImportResult> {
  ctx.onPhase?.('read');
  const bundle = await openBundle(zipPath, ctx.signal, ctx.temporaryDirectory);

  await mkdir(options.journalDir, { recursive: true });

  let work: SqliteSession | undefined;
  let journal: JournalStore | undefined;

  try {
    work = await SqliteSession.open({
      database: path.join(bundle.root, 'index.sqlite'),
      signal: ctx.signal,
      timeoutMs: ctx.timeoutMs,
      busyTimeoutMs: ctx.busyTimeoutMs,
    });

    journal = await JournalStore.open({
      journalDir: options.journalDir,
      targetKey: options.targetKey,
      signal: ctx.signal,
    });

    await work.exec(`
CREATE TABLE chat (
  ordinal INTEGER PRIMARY KEY,
  source_id TEXT NOT NULL UNIQUE,
  snapshot_hash TEXT NOT NULL,
  quality TEXT NOT NULL,
  target_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT NOT NULL
);
CREATE TABLE bubble (
  ordinal INTEGER NOT NULL,
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  component TEXT NOT NULL,
  PRIMARY KEY (ordinal, source_id),
  UNIQUE (ordinal, target_id)
);
CREATE TABLE bubble_root (
  ordinal INTEGER NOT NULL,
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  PRIMARY KEY (ordinal, source_id),
  UNIQUE (ordinal, target_id)
);
CREATE TABLE res (
  ordinal INTEGER NOT NULL,
  class TEXT NOT NULL,
  id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  storage_class TEXT,
  filename TEXT,
  extension TEXT,
  aliases TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX res_id ON res(ordinal,class,id);
CREATE INDEX res_name ON res(ordinal,class,filename);
CREATE TABLE referenced(ordinal INTEGER, id TEXT, PRIMARY KEY(ordinal,id));
CREATE TABLE dep (
  ordinal INTEGER NOT NULL,
  sort_key TEXT NOT NULL,
  canonical TEXT NOT NULL,
  PRIMARY KEY (ordinal, sort_key)
);`);

    const pair = await inspectPair(ctx, workspace);

    if (
      !pair.glInfo.layout.canWriteGlobal ||
      !pair.wsInfo.layout.canWriteWorkspace
    ) {
      throw new Error(
        pair.glInfo.layout.unsupportedReason ||
          'Refusing to write an unknown schema.',
      );
    }

    await assertStoredListsReadable({
      connWs: pair.connWs,
      connGl: pair.connGl,
      wsInfo: pair.wsInfo.layout,
      glInfo: pair.glInfo.layout,
    });

    await reconcilePendingProjection({
      ctx,
      connGl: pair.connGl,
      journal,
    });

    const finishReconciliation = await reconcile(journal, ctx, workspace, pair);

    ctx.onPhase?.('validate');

    await work.exec('BEGIN;');

    const plan = await scanAll({
      ctx,
      root: bundle.root,
      work,
      workspace,
      pair,
      journal,
      targetKey: options.targetKey,
      allowPartial: options.allowPartial || !!options.onRecovery,
    });

    await work.exec('COMMIT;');
    const preview = await recoveryPreview(work, plan);

    if (
      options.onRecovery &&
      (options.confirmCopy || preview.historyOnly || preview.skipped) &&
      (plan.create.length || !plan.already.length)
    ) {
      const accepted = await options.onRecovery(preview);

      ctx.signal?.throwIfAborted();

      if (!plan.create.length) {
        const error = new TransferError(
          'No recoverable chats were found. Missing message bodies cannot be recreated.',
        );

        error.code = 'NOTHING_TO_IMPORT';

        throw error;
      }

      if (!accepted)
        throw new DOMException('Recovery cancelled.', 'AbortError');
    }

    ctx.signal?.throwIfAborted();
    await finishReconciliation();
    let modelConfigsRepaired = 0;

    for (const item of plan.repair) {
      ctx.signal?.throwIfAborted();

      const row = await oneChat(work, item.ordinal);

      const outcome = await projectImportedModel({
        ctx,
        connGl: pair.connGl,
        workspace,
        root: bundle.root,
        ordinal: item.ordinal,
        targetComposerId: item.targetComposerId,
        snapshotHash: row.hash,
        row,
        journal,
      });

      if (outcome === 'applied') modelConfigsRepaired++;
    }

    if (!plan.create.length)
      return resultFrom(plan, [], [], modelConfigsRepaired);
    const operationId = randomUUID();

    await journal.beginPending({ operationId, phase: 'prepared' });
    const written: string[] = [];
    const historyOnlyIds: string[] = [];
    let durable = false;

    try {
      for (const [index, ordinal] of plan.create.entries()) {
        ctx.signal?.throwIfAborted();

        const row = await oneChat(work, ordinal);

        const hostRoot = path.join(
          bundle.root,
          'chats',
          ordinalName(ordinal),
          'host-snapshot',
        );

        let hostSnapshot:
          { sessionId: string; database: string; meta: string } | undefined;

        try {
          const component = asObject(
            parseBoundedJson(
              await readFile(path.join(hostRoot, 'component.json')),
              'host snapshot component',
            ),
            'host snapshot component',
          );

          if (
            component.class !== 'host-snapshot' ||
            component.version !== 1 ||
            component.sessionId !== row.sourceId
          )
            throw new Error('Invalid host snapshot component.');

          hostSnapshot = {
            sessionId: row.sourceId,
            database: path.join(hostRoot, 'session.sqlite'),
            meta: path.join(hostRoot, 'meta.json'),
          };

          await validateHostSnapshot(hostSnapshot);
          // Native stores cannot be remapped. Renderer fallback still imports normally.
          if (row.targetId !== row.sourceId) hostSnapshot = undefined;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }

        const header = asObject(
          parseBoundedJson(
            await readFile(
              path.join(
                bundle.root,
                'chats',
                ordinalName(ordinal),
                'header.json',
              ),
            ),
            'header',
            ctx.maxJsonProperties,
          ),
          'header',
        );

        const chatName =
          typeof header.name === 'string' ? header.name : row.sourceId;

        const chatIndex = index + 1;

        const chatCtx = {
          ...ctx,
          onPhase: (
            phase: import('./types').TransferPhase,
            /** Progress counts for this phase. */
            metrics: import('./types').TransferPhaseMetrics = {},
          ) =>
            ctx.onPhase?.(phase, {
              ...metrics,
              chatName,
              chatIndex,
              chatTotal: plan.create.length,
            }),
        };

        try {
          await inChat(row.sourceId, chatName, () =>
            writeOne({
              ctx: chatCtx,
              workspace,
              pair,
              root: bundle.root,
              work: work!,
              journal: journal!,
              operationId,
              ordinal,
              row,
              plansDir: plansDirOf(ctx),
              canvasesDir: canvasesDirOf(ctx, workspace),
              onDurable: () => {
                durable = true;
              },
            }),
          );
        } catch (err) {
          if (!isPreflightKvConflict(err)) throw err;

          plan.skipped.push({
            composerId: row.sourceId,
            name: chatName,
            reason: 'a stored resource differs',
          });

          continue;
        }

        written.push(row.targetId);

        if (hostSnapshot) {
          const sessionEffectId = `session:${row.sourceId}`;
          const sessionHash = await hashFile(hostSnapshot.database);

          await journal.planEffect({
            operationId,
            effectId: sessionEffectId,
            kind: 'session',
            target: row.sourceId,
            desiredHash: sessionHash.sha256,
          });

          await journal.setEffectState(
            operationId,
            sessionEffectId,
            'prepared',
          );

          await publishHostSnapshot({
            userDataDir: userDataDirFromGlobalDb(workspace.globalDbPath),
            snapshot: hostSnapshot,
            rendererCollision: row.targetId !== row.sourceId,
          });

          await journal.setEffectState(
            operationId,
            sessionEffectId,
            'verified',
            sessionHash.sha256,
          );
        }

        if (row.quality === 'history-only') historyOnlyIds.push(row.targetId);

        await journal.addReceipt({
          sourceComposerId: row.sourceId,
          snapshotHash: row.hash,
          targetComposerId: row.targetId,
          quality: row.quality,
        });
      }

      await journal.clearPending();
    } catch (err) {
      if (!written.length && !durable) {
        await journal.clearPending();

        throw err;
      }

      const wrapped = new TransferError(
        err instanceof Error ? err.message : String(err),
      );

      wrapped.code = 'PARTIAL';

      throw wrapped;
    }

    return resultFrom(plan, written, historyOnlyIds, modelConfigsRepaired);
  } finally {
    await work?.close().catch(() => undefined);
    await journal?.close().catch(() => undefined);
    await bundle.close();
  }
}
