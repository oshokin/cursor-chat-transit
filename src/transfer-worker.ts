import { observeTransfer } from './transfer-events';
import type { TransferJob } from './transfer-process';
import { exportToFile } from './export-transfer';
import { importFromBundle } from './import-bundle';
import type { TransferContext } from './types';

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

process.on('message', (message: { type?: string; job?: TransferJob }) => {
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
      phase: (phase, metrics) => {
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
});

/** Run the export or import described by one worker job. */
async function run(job: TransferJob): Promise<unknown> {
  const ctx: TransferContext = {
    executable: job.executable,
    initFile: job.initFile,
    timeoutMs: job.timeoutMs,
    busyTimeoutMs: job.busyTimeoutMs,
    plansDir: job.plansDir,
    canvasesDir: job.canvasesDir,
    signal: abort.signal,
    onPhase: (phase, metrics) => {
      sendUpdate({ type: 'phase', phase, metrics });
    },
    onNote: (note) => {
      sendUpdate({ type: 'note', note });
    },
  };

  if (job.kind === 'export') {
    return exportToFile(ctx, job.workspace, job.filePath, job.selectedIds);
  }

  return importFromBundle(ctx, job.filePath, job.workspace, {
    allowPartial: job.allowPartial,
    journalDir: job.journalDir,
  });
}
