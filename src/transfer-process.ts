import type { DeletionJob } from './deletion-types';
import type { RecoveryPreview } from './recovery-preview';
import type { StatisticsJob, StatisticsUpdate } from './statistics';
import type { TransferEvent } from './transfer-events';
import type {
  TransferPhase,
  TransferPhaseMetrics,
  WorkspaceEntry,
} from './types';
import type { CatalogueJob, CatalogueUpdate } from './workspace-catalogue';

/** Export or import request sent to the transfer process. */
export interface TransferJob {
  /** Preserve known preview fragments and labelled message gaps during export. */
  recoverText?: boolean;
  /** Which operation to run. */
  kind: 'export' | 'import' | 'list-chats';
  /** sqlite3 executable. */
  executable: string;
  /** sqlite3 init file. */
  initFile: string;
  /** Per-process sqlite timeout. */
  timeoutMs?: number;
  busyTimeoutMs?: number;
  plansDir?: string;
  /** Canvas directory override. */
  canvasesDir?: string;
  /** Source or destination workspace. */
  workspace: WorkspaceEntry;
  /** Export destination or import archive. */
  filePath: string;
  /** Export selection. Omit to export every listed chat. */
  selectedIds?: string[];
  /** Assess source viability while preparing a recovery archive. */
  assessRecovery?: boolean;
  /** Import recovery switch. */
  allowPartial?: boolean;
  /** Pause after preflight for explicit consent to incomplete imports. */
  interactiveRecovery?: boolean;
  /** Also review a complete source when recovering one chat into a copy. */
  confirmCopy?: boolean;
  /** Receipt database directory. */
  journalDir?: string;
}

/** Start the transfer process and return its result. There is no in-process fallback. */
export async function runTransfer<T>(
  job: TransferJob | StatisticsJob | CatalogueJob | DeletionJob,
  /** Host callbacks for this worker. */
  handlers: {
    /** One workspace header list produced by an on-demand search. */
    onCatalogue?: (row: CatalogueUpdate) => void;
    /** Host decision after a recovery preview. True continues the import. */
    onRecovery?: (
      /** Counts and examples; no message bodies. */
      preview: RecoveryPreview,
    ) => Promise<boolean>;
    /** One completed statistics row. */
    onStatistics?: (
      /** Refresh the UI as results arrive. */
      update: StatisticsUpdate,
    ) => void;
    /** Cancellation. */
    signal?: AbortSignal;
    /** Progress from the child. */
    onPhase?: (
      phase: TransferPhase,
      /** Progress counts for this phase. */
      metrics?: TransferPhaseMetrics,
    ) => void;
    /** Structured file and byte events from the child. */
    onEvent?: (event: TransferEvent) => void;
    /** Bounded note from the child. */
    onNote?: (message: string) => void;
  },
): Promise<T> {
  handlers.signal?.throwIfAborted();
  const { fork } = await import('node:child_process');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const compiled = path.join(__dirname, 'transfer-worker.js');
  const source = path.join(__dirname, 'transfer-worker.ts');
  const script = fs.existsSync(compiled) ? compiled : source;
  const execArgv = script.endsWith('.ts') ? ['--import', 'tsx'] : [];

  const child = fork(script, [], {
    execArgv,
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
  });

  return await new Promise<T>((resolve, reject) => {
    let settled = false;

    /** Settle the worker promise once. */
    const finish = (
      /** Resolve or reject the worker promise. */
      fn: () => void,
    ) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    /** Reject the worker promise once. */
    const fail = (
      /** Failure from the worker. */
      err: Error,
    ) => finish(() => reject(err));

    /** Handle one message from the other process. */
    const onMessage = (message: {
      /** IPC kind: event, phase, note, done, error, or recovery. */
      type: string;
      /** Preflight counts when `type` is `recovery`. No message bodies. */
      preview?: RecoveryPreview;
      /** A compact statistics result; no chat payloads. */
      statistics?: StatisticsUpdate;
      /** Incremental headers, without message bodies. */
      catalogue?: CatalogueUpdate;
      /** File or byte event when `type` is `event`. */
      event?: TransferEvent;
      /** Named transfer stage when `type` is `phase`. */
      phase?: TransferPhase;
      /** Counts for that stage. */
      metrics?: TransferPhaseMetrics;
      /** Bounded note when `type` is `note`. */
      note?: string;
      /** Transfer result when `type` is `done`. */
      result?: T;
      /** Error text when `type` is `error`. */
      message?: string;
      /** Error name copied onto the thrown Error. */
      name?: string;
      /** Stable error code copied onto the thrown Error. */
      code?: string;
      /** Extra error detail copied onto the thrown Error. */
      detail?: string;
    }) => {
      if (message.type === 'recovery' && message.preview) {
        void (handlers.onRecovery?.(message.preview) || Promise.resolve(false))
          .then((/** Whether the worker accepted the job. */ accepted) => {
            if (child.connected)
              child.send(
                {
                  type: 'recovery-decision',
                  accepted: accepted && !handlers.signal?.aborted,
                },
                () => undefined,
              );
          })
          .catch(() => {
            if (child.connected)
              child.send({ type: 'cancel' }, () => undefined);
          });
      }

      if (message.type === 'catalogue' && message.catalogue)
        handlers.onCatalogue?.(message.catalogue);

      if (message.type === 'statistics' && message.statistics)
        handlers.onStatistics?.(message.statistics);

      if (message.type === 'event' && message.event)
        handlers.onEvent?.(message.event);

      if (message.type === 'phase' && message.phase) {
        handlers.onPhase?.(message.phase, message.metrics);
      }

      if (message.type === 'note' && message.note)
        handlers.onNote?.(message.note);

      if (message.type === 'done') {
        finish(() => resolve(message.result as T));
      }

      if (message.type === 'error') {
        const err = new Error(message.message || 'Transfer failed.');

        if (message.name) err.name = message.name;
        /** Process exit code or error code. */
        if (message.code)
          (
            err as {
              /** Error code copied from the worker. */
              code?: string;
            }
          ).code = message.code;
        if (message.detail)
          /** Second line of a notice. */
          (
            err as {
              /** Diagnostic copied from the worker. */
              detail?: string;
            }
          ).detail = message.detail;
        fail(err);
      }
    };

    /** Reject when the child process stops. */
    const onExit = (
      /** Exit code, or null when the child was signaled. */
      code: number | null,
    ) => {
      fail(
        new Error(
          `The transfer process stopped (${code ?? 'signal'}). Cursor was not restarted.`,
        ),
      );
    };

    /** Cancel the child when the caller aborts. */
    const onAbort = () => {
      if (child.connected) child.send({ type: 'cancel' }, () => undefined);
    };

    /** Drop listeners after the walk settles. */
    const cleanup = () => {
      child.off('message', onMessage);
      child.off('exit', onExit);
      handlers.signal?.removeEventListener('abort', onAbort);
    };

    child.on('message', onMessage);
    child.once('exit', onExit);
    child.once('error', (err) => fail(err));
    handlers.signal?.addEventListener('abort', onAbort, { once: true });

    if (handlers.signal?.aborted) onAbort();

    child.send({ type: 'start', job }, (error) => {
      if (error) fail(error);
    });
  });
}
