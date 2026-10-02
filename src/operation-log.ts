import { formatLogLine } from './log-format';
import { durationField } from './duration';
import type { TransferEvent } from './transfer-events';
import { randomUUID } from 'node:crypto';
import type { TransitLog } from './output-ui';
import type { TransferPhase, TransferPhaseMetrics } from './types';

/** Which transfer this log instance describes. */
type OperationKind =
  'export' | 'import' | 'workspace statistics' | 'chat statistics';

/** Terminal outcome written once at finish. */
type Result = 'completed' | 'incomplete' | 'cancelled' | 'failed' | 'partial';

/** Log bounded structured operation facts, never SQL, payloads, prompts, or raw stderr. */
export function startOperationLog(
  channel: TransitLog,
  kind: OperationKind,
  now = () => performance.now(),
) {
  const id = randomUUID().slice(0, 8);
  const started = now();
  let finalElapsed: number | undefined;
  let finished = false;
  let lastPhaseLog = '';
  let lastPhaseTime = -Infinity;

  line('INFO', `${kind} started`);

  /** One operation-log line. The level word is in the text; Cursor will not color a log channel. */
  function line(level: 'INFO' | 'WARN' | 'ERROR', text: string) {
    const formatted = formatLogLine(level, `${text} operation=${id}`);

    if (level === 'ERROR') channel.error(formatted);
    else if (level === 'WARN') channel.warn(formatted);
    else channel.info(formatted);
  }

  /** Collapse whitespace and cap a free-text field. */
  function clip(message: string, max = 300): string {
    return message.replace(/[\r\n\t]/g, ' ').slice(0, max);
  }

  return {
    id,
    /** Shared monotonic origin for the log and sidebar, including selection time. */
    startedAt: started,
    /** Final duration is frozen at finish, including no-op, failed and cancelled runs. */
    elapsedMs: () => finalElapsed ?? Math.max(0, Math.round(now() - started)),
    /** Concrete file/chat action with duration and byte units; no payloads. */
    event(event: TransferEvent) {
      if (finished) return;

      const fields = Object.entries(event)
        .filter(
          ([key, value]) =>
            value !== undefined && key !== 'action' && key !== 'status',
        )
        .map(([key, value]) =>
          key === 'bytes' && typeof value === 'number'
            ? `bytes=${value} (${humanBytes(value)})`
            : (key === 'elapsedMs' || key === 'timeoutMs') &&
                typeof value === 'number'
              ? durationField(key, value)
              : `${key}=${typeof value === 'string' ? JSON.stringify(clip(value, 4096)) : value}`,
        );

      line(
        event.status === 'failed' ? 'ERROR' : 'INFO',
        `${clip(event.action)}${event.status === 'info' ? '' : ` ${event.status}`} ${fields.join(' ')}`,
      );
    },
    /** Emit coarse phase progress; skip per-item ticks that belong on the progress bar. */
    phase(phase: TransferPhase, metrics: TransferPhaseMetrics = {}) {
      if (finished) return;
      const { processed, total } = metrics;

      const title = phaseLabels[phase];

      const context = [
        metrics.chatIndex && metrics.chatTotal
          ? `Chat ${metrics.chatIndex} of ${metrics.chatTotal}`
          : '',
        metrics.chatName
          ? `chat=${JSON.stringify(clip(metrics.chatName, 4096))}`
          : '',
        metrics.file ? `file=${JSON.stringify(clip(metrics.file, 4096))}` : '',
        typeof processed === 'number' && typeof total === 'number'
          ? metrics.unit === 'bytes'
            ? `${processed} bytes (${humanBytes(processed)}) / ${total} bytes (${humanBytes(total)})`
            : `${processed.toLocaleString('en-US')} / ${total.toLocaleString('en-US')} ${metrics.unit || 'items'}`
          : typeof processed === 'number'
            ? `${processed.toLocaleString('en-US')} ${metrics.unit || 'items'} processed`
            : '',
        metrics.chats !== undefined ? `Chats: ${metrics.chats}` : '',
        metrics.bubbles !== undefined ? `Messages: ${metrics.bubbles}` : '',
        metrics.resources !== undefined
          ? `Resources: ${metrics.resources}`
          : '',
        metrics.missing !== undefined ? `Missing: ${metrics.missing}` : '',
        metrics.bytes !== undefined
          ? `bytes=${metrics.bytes} (${humanBytes(metrics.bytes)})`
          : '',
      ].filter(Boolean);

      const key = `${phase}:${metrics.scope || ''}:${metrics.chatIndex || metrics.chatName || ''}:${metrics.unit || ''}`;
      const now = performance.now();

      // Log transitions, completion and a heartbeat at most every five seconds.
      if (
        key === lastPhaseLog &&
        now - lastPhaseTime < 5000 &&
        processed !== total
      )
        return;
      const text = `${title}${context.length ? ` · ${context.join(' · ')}` : ''}`;

      if (
        key === lastPhaseLog &&
        processed === undefined &&
        now - lastPhaseTime < 5000
      )
        return;
      lastPhaseLog = key;
      lastPhaseTime = now;
      line('INFO', text);
    },
    /** Record the full path and size of a file the user chose. */
    file(name: string, bytes?: number) {
      if (finished) return;

      const size =
        typeof bytes === 'number' && Number.isFinite(bytes) && bytes >= 0
          ? ` bytes=${Math.round(bytes)} (${humanBytes(bytes)})`
          : '';

      line(
        'INFO',
        `Selected archive file=${JSON.stringify(clip(name, 4096))}${size}`,
      );
    },
    /** One informational fact, such as import counts. Not a warning. */
    fact(message: string) {
      if (finished) return;
      const text = clip(message);

      if (!text) return;
      line('INFO', text);
    },
    /** Name a specific chat or other non-failure fact. Do not dump payloads. */
    note(message: string) {
      if (finished) return;
      const text = clip(message);

      if (!text) return;
      line('WARN', text);
    },
    /** Record a terminal result exactly once. Partial commit is distinct from cancellation. */
    finish(result: Result, errorCode?: string, err?: unknown) {
      if (finished) return;
      finished = true;
      finalElapsed = Math.max(0, Math.round(now() - started));

      const code =
        errorCode && /^[A-Z0-9_]{1,40}$/.test(errorCode)
          ? ` code=${errorCode}`
          : '';

      const reason =
        err instanceof Error && err.message
          ? ` message=${JSON.stringify(clip(err.message, 240))}`
          : '';

      const text = `${kind} ${result} ${durationField('elapsedMs', finalElapsed)}${code}${reason}`;

      if (result === 'failed' || result === 'partial') line('ERROR', text);
      else if (result === 'incomplete') line('WARN', text);
      else line('INFO', text);
    },
  };
}

/** Binary units beside exact byte counts. */
export function humanBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];

  let size = Math.max(0, bytes),
    unit = 0;

  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }

  return `${size.toFixed(unit ? 2 : 0)} ${units[unit]}`;
}

/** Human actions for every internal transfer phase. */
const phaseLabels: Record<TransferPhase, string> = {
  selection: 'Read selected chats',
  read: 'Read chat data',
  extract: 'Extract archive',
  validate: 'Validate archive data',
  collect: 'Collect chat dependencies',
  prepare: 'Prepare chat records',
  write: 'Write chat records',
  'global-commit': 'Chat data committed; update workspace',
  'workspace-commit': 'Workspace updated',
  verify: 'Verify imported chat data',
  pack: 'Pack archive',
};
