import { deleteSelectedChats } from './chat-deletion';
import type { DeletionJob } from './deletion-types';
import { exportToFile, listWorkspaceChats } from './export-transfer';
import { importFromBundle } from './import-bundle';
import type { RecoveryPreview } from './recovery-preview';
import { runStatistics, type StatisticsJob } from './statistics';
import { observeTransfer } from './transfer-events';
import type { TransferJob } from './transfer-process';
import type { TransferContext } from './types';
import { runCatalogue, type CatalogueJob } from './workspace-catalogue';

/** Cancels the worker when the extension host disconnects. */
const abort = new AbortController();

// Losing the Extension Host must release writers, not orphan them.
process.once('disconnect', () => abort.abort());
process.once('SIGTERM', () => abort.abort());
/** True after the worker accepts its start message. */
let started = false;

/** IPC can disappear between a connection check and send; stop without an unhandled error. */
function sendUpdate(message: Record<string, unknown>): void {
  if (!process.connected) return;

  try {
    process.send?.(message, (error) => {
      if (error) abort.abort();
    });
  } catch {
    abort.abort();
  }
}

process.on(
  'message',
  (message: {
    /** Record type discriminant. */
    type?: string;
    job?: TransferJob | StatisticsJob | CatalogueJob | DeletionJob;
  }) => {
    if (message.type === 'cancel') {
      abort.abort();

      return;
    }

    if (message.type !== 'start' || !message.job || started) return;
    started = true;

    const job = message.job;

    void observeTransfer(
      {
        event: (event) => {
          sendUpdate({ type: 'event', event });
        },
        phase: (
          phase,
          /** Progress counts for this phase. */
          metrics,
        ) => {
          sendUpdate({ type: 'phase', phase, metrics });
        },
      },
      () => run(job),
    ).then(
      (result) => {
        if (process.connected)
          process.send?.({ type: 'done', result }, () => process.exit(0));
        else process.exit(0);
      },
      (err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err));

        if (!process.connected) {
          process.exitCode = 1;

          return;
        }

        process.send?.(
          {
            type: 'error',
            message: error.message,
            name: error.name,
            code: 'code' in error ? String(error.code) : undefined,
            detail:
              'detail' in error && error.detail
                ? String(error.detail)
                : undefined,
          },
          () => process.exit(1),
        );
      },
    );
  },
);

/** Run the export or import described by one worker job. */
async function run(
  job: TransferJob | StatisticsJob | CatalogueJob | DeletionJob,
): Promise<unknown> {
  if (job.kind === 'workspace-catalogue')
    return runCatalogue(
      job,
      abort.signal,
      (/** Workspace catalogue update. */ catalogue) =>
        sendUpdate({ type: 'catalogue', catalogue }),
    );

  if (job.kind === 'workspace-statistics' || job.kind === 'chat-statistics') {
    return runStatistics(
      job,
      abort.signal,
      (/** Statistics update. */ statistics) =>
        sendUpdate({ type: 'statistics', statistics }),
    );
  }

  if (job.kind === 'delete-chats')
    return deleteSelectedChats(
      {
        ...job,
        signal: abort.signal,
        onPhase: (
          phase,
          /** Progress counts for this phase. */
          metrics,
        ) => sendUpdate({ type: 'phase', phase, metrics }),
        onNote: (/** Progress note. */ note) =>
          sendUpdate({ type: 'note', note }),
      },
      job.workspaces,
      job.targets,
    );

  const ctx: TransferContext = {
    recoverText: job.recoverText,
    executable: job.executable,
    initFile: job.initFile,
    timeoutMs: job.timeoutMs,
    busyTimeoutMs: job.busyTimeoutMs,
    plansDir: job.plansDir,
    canvasesDir: job.canvasesDir,
    signal: abort.signal,
    onPhase: (
      phase,
      /** Progress counts for this phase. */
      metrics,
    ) => {
      sendUpdate({ type: 'phase', phase, metrics });
    },
    onNote: (/** Progress note. */ note) => {
      sendUpdate({ type: 'note', note });
    },
  };

  if (job.kind === 'list-chats')
    return listWorkspaceChats(ctx, job.workspace, { includeColumnDates: true });

  if (job.kind === 'export') {
    return exportToFile(
      ctx,
      job.workspace,
      job.filePath,
      job.selectedIds,
      job.assessRecovery,
    );
  }

  return importFromBundle(ctx, job.filePath, job.workspace, {
    allowPartial: job.allowPartial,
    onRecovery: job.interactiveRecovery ? requestRecovery : undefined,
    confirmCopy: job.confirmCopy,
    journalDir: job.journalDir,
  });
}

/** Wait without holding a Cursor read transaction; cancellation also releases this wait. */
function requestRecovery(
  /** Counts and examples; no message bodies. */
  preview: RecoveryPreview,
): Promise<boolean> {
  abort.signal.throwIfAborted();

  return new Promise((resolve, reject) => {
    /** Drop listeners after the walk settles. */
    const cleanup = () => {
      process.off('message', onMessage);
      abort.signal.removeEventListener('abort', onAbort);
    };

    /** Cancel the child when the caller aborts. */
    const onAbort = () => {
      cleanup();
      reject(new DOMException('Recovery cancelled.', 'AbortError'));
    };

    /** Handle one message from the other process. */
    const onMessage = (message: {
      /** Worker message kind. */
      type?: string;
      /** Host decision for a recovery preview. */
      accepted?: boolean;
    }) => {
      if (message.type !== 'recovery-decision') return;
      cleanup();
      resolve(message.accepted === true);
    };

    process.on('message', onMessage);
    abort.signal.addEventListener('abort', onAbort, { once: true });
    sendUpdate({ type: 'recovery', preview });
  });
}
