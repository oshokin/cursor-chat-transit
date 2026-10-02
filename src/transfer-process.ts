import type { StatisticsJob, StatisticsUpdate } from './statistics';
import type { TransferEvent } from './transfer-events';
import type {
  TransferPhase,
  TransferPhaseMetrics,
  WorkspaceEntry,
} from './types';

/** Export or import request sent to the transfer process. */
export interface TransferJob {
  /** Which operation to run. */
  kind: 'export' | 'import';
  /** sqlite3 executable. */
  executable: string;
  /** sqlite3 init file. */
  initFile: string;
  /** Per-process sqlite timeout. */
  timeoutMs?: number;
  /** SQLite busy timeout. */
  busyTimeoutMs?: number;
  /** Plans directory. */
  plansDir?: string;
  /** Canvas directory override. */
  canvasesDir?: string;
  /** Source or destination workspace. */
  workspace: WorkspaceEntry;
  /** Export destination or import archive. */
  filePath: string;
  /** Export selection. Omit to export every listed chat. */
  selectedIds?: string[];
  /** Import recovery switch. */
  allowPartial?: boolean;
  /** Receipt database directory. */
  journalDir?: string;
}

/** Start the transfer process and return its result. There is no in-process fallback. */
export async function runTransfer<T>(
  job: TransferJob | StatisticsJob,
  handlers: {
    /** One completed statistics row. */
    onStatistics?: (update: StatisticsUpdate) => void;
    /** Cancellation. */
    signal?: AbortSignal;
    /** Progress from the child. */
    onPhase?: (phase: TransferPhase, metrics?: TransferPhaseMetrics) => void;
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

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    const fail = (err: Error) => finish(() => reject(err));

    const onMessage = (message: {
      /** IPC kind: event, phase, note, done, or error. */
      type: string;
      /** A compact statistics result; no chat payloads. */
      statistics?: StatisticsUpdate;
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
        if (message.code) (err as { code?: string }).code = message.code;
        if (message.detail)
          (err as { detail?: string }).detail = message.detail;
        fail(err);
      }
    };

    const onExit = (code: number | null) => {
      fail(
        new Error(
          `The transfer process stopped (${code ?? 'signal'}). Cursor was not restarted.`,
        ),
      );
    };

    const onAbort = () => {
      if (child.connected) child.send({ type: 'cancel' }, () => undefined);
    };

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
