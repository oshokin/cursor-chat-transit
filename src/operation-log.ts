import { randomUUID } from 'node:crypto';
import type { TransitLog } from './output-ui';
import type { TransferPhase, TransferPhaseMetrics } from './types';

/** Which transfer this log instance describes. */
type OperationKind = 'export' | 'import';
/** Terminal outcome written once at finish. */
type Result = 'completed' | 'incomplete' | 'cancelled' | 'failed' | 'partial';

/** Log bounded structured operation facts, never SQL, payloads, prompts, or raw stderr. */
export function startOperationLog(channel: TransitLog, kind: OperationKind) {
  const id = randomUUID().slice(0, 8);
  const started = performance.now();
  let finished = false;
  channel.info(`[${id}] ${kind} started`);
  return {
    id,
    /** Emit coarse phase progress; skip per-item ticks that belong on the progress bar. */
    phase(phase: TransferPhase, metrics: TransferPhaseMetrics = {}) {
      if (finished) return;
      const { processed, total } = metrics;
      if (
        typeof processed === 'number' &&
        typeof total === 'number' &&
        processed > 0 &&
        processed < total
      ) {
        return;
      }
      const values = Object.entries(metrics)
        .filter(
          ([, value]) =>
            typeof value === 'number' && Number.isFinite(value) && value >= 0,
        )
        .map(([key, value]) => `${key}=${value}`)
        .join(' ');
      channel.info(`[${id}] ${phase}${values ? ` ${values}` : ''}`);
    },
    /** Name a specific chat; do not dump payloads. */
    note(message: string) {
      if (finished) return;
      const text = message.replace(/[\r\n\t]/g, ' ').slice(0, 300);
      if (!text) return;
      channel.warn(`[${id}] ${text}`);
    },
    /** Record a terminal result exactly once. Partial commit is distinct from cancellation. */
    finish(result: Result, errorCode?: string) {
      if (finished) return;
      finished = true;
      const code =
        errorCode && /^[A-Z0-9_]{1,40}$/.test(errorCode)
          ? ` code=${errorCode}`
          : '';
      const message = `[${id}] ${result} elapsedMs=${Math.round(performance.now() - started)}${code}`;
      if (result === 'failed' || result === 'partial') channel.error(message);
      else if (result === 'incomplete') channel.warn(message);
      else channel.info(message);
    },
  };
}
