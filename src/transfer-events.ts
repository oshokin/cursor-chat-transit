import { AsyncLocalStorage } from 'node:async_hooks';
import type { TransferPhase, TransferPhaseMetrics } from './types';

/** Small transport event. Payloads, SQL and authentication data are never fields. */
export interface TransferEvent {
  /** Short verb phrase for the operation log. */
  action: string;
  /** Outcome of this step. */
  status: 'started' | 'completed' | 'failed' | 'info';
  /** Filesystem path involved, when there is one. */
  path?: string;
  /** Logical key, such as a composer or kv id. */
  key?: string;
  /** Where the bytes were read from. */
  source?: string;
  /** Where the bytes were written. */
  destination?: string;
  /** Composer id this event belongs to. */
  chatId?: string;
  /** Display name of that chat. */
  chatName?: string;
  /** Byte count for this step. */
  bytes?: number;
  /** Duration of this step. */
  elapsedMs?: number;
  /** Wall-clock deadline for this step. */
  timeoutMs?: number;
  /** Stable code when `status` is `failed`. */
  errorCode?: string;
  /** Bounded facts such as a KV conflict. Never payload bytes or SQL. */
  detail?: string;
}

/** Per-operation observers, also usable by integration tests without VS Code. */
interface Observers {
  /** Receives each transport event. */
  event?: (event: TransferEvent) => void;
  /** Receives phase progress. */
  phase?: (phase: TransferPhase, metrics?: TransferPhaseMetrics) => void;
  /** Composer id attached to nested events. */
  chatId?: string;
  /** Display name attached to nested events. */
  chatName?: string;
}

/** Observers for the transfer currently running on this async stack. */
const scope = new AsyncLocalStorage<Observers>();

/** Bind operation observers to its asynchronous work. */
export function observeTransfer<T>(observers: Observers, run: () => T): T {
  return scope.run(observers, run);
}

/** Attach one chat's identity to all nested file operations. */
export function inChat<T>(chatId: string, chatName: string, run: () => T): T {
  return scope.run({ ...scope.getStore(), chatId, chatName }, run);
}

/** Emit one bounded, structured fact. */
export function transferEvent(event: TransferEvent): void {
  const observers = scope.getStore();

  observers?.event?.({
    chatId: observers.chatId,
    chatName: observers.chatName,
    ...event,
  });
}

/** File or record progress; callers throttle byte updates before IPC. */
export function transferProgress(
  phase: TransferPhase,
  metrics: TransferPhaseMetrics,
): void {
  const observers = scope.getStore();

  observers?.phase?.(phase, { chatName: observers.chatName, ...metrics });
}

/** Log a concrete action before it starts, including a failed action's path. */
export async function traceIO<T>(
  action: string,
  fields: Omit<TransferEvent, 'action' | 'status'>,
  run: () => Promise<T>,
): Promise<T> {
  const started = performance.now();

  transferEvent({ action, status: 'started', ...fields });

  try {
    const result = await run();

    transferEvent({
      action,
      status: 'completed',
      ...fields,
      elapsedMs: Math.round(performance.now() - started),
    });

    return result;
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error
        ? String(error.code)
        : 'FAILED';

    const detail =
      error &&
      typeof error === 'object' &&
      'detail' in error &&
      typeof error.detail === 'string'
        ? error.detail
        : undefined;

    transferEvent({
      action,
      status: 'failed',
      ...fields,
      errorCode: code,
      ...(detail ? { detail } : {}),
      elapsedMs: Math.round(performance.now() - started),
    });

    throw error;
  }
}
