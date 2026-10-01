import type { TransferPhase, TransferPhaseMetrics } from './types';

/** Native phase order, independent of guessed percentage weights. */
const steps = {
  export: [
    ['selection'],
    ['backup'],
    ['read', 'prepare', 'collect'],
    ['write', 'verify'],
    ['pack'],
  ],
  import: [
    ['read', 'extract'],
    ['validate', 'collect'],
    ['backup'],
    ['prepare'],
    ['write', 'global-commit', 'workspace-commit'],
    ['verify'],
  ],
};

/** User-facing duration with stable minute/second units. */
export function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));

  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

/** Estimate only measurable work in the current file/stage, never invent whole-operation ETA. */
export class ProgressModel {
  /** Latest reported phase. */
  private phase?: TransferPhase;
  /** Latest counts for that phase. */
  private metrics: TransferPhaseMetrics = {};
  /** Identity of the rate window currently being measured. */
  private scope = '';
  /** Clock time when the current scope began. */
  private scopeStarted: number;
  /** Clock time of the last increase in `processed`. */
  private lastAdvance: number;
  /** Clock time of the last `update`. */
  private measuredAt: number;
  /** `processed` at the start of the current scope. */
  private initial = 0;
  /** Begin one transfer using a monotonic clock for durations. */
  constructor(
    private readonly kind: 'export' | 'import',
    private readonly started = performance.now(),
  ) {
    this.scopeStarted = started;
    this.lastAdvance = started;
    this.measuredAt = started;
  }
  /** Reset rate only when the measured scope, unit or chat changes. */
  update(
    phase: TransferPhase,
    metrics: TransferPhaseMetrics = {},
    now = performance.now(),
  ): void {
    const scope = `${phase}:${metrics.scope || metrics.file || ''}:${metrics.chatIndex || ''}:${metrics.chatName || ''}:${metrics.unit || ''}`;

    if (
      scope !== this.scope ||
      (metrics.processed ?? 0) < (this.metrics.processed ?? 0)
    ) {
      this.scope = scope;
      this.scopeStarted = now;
      this.initial = metrics.processed ?? 0;
      this.lastAdvance = now;
    }

    if ((metrics.processed ?? 0) > (this.metrics.processed ?? 0))
      this.lastAdvance = now;
    this.measuredAt = now;
    this.phase = phase;
    this.metrics = metrics;
  }
  /** Timing and percentage describe this scope; stalled or unknown totals show no ETA. */
  snapshot(now = performance.now()) {
    const m = this.metrics;

    const index = steps[this.kind].findIndex((group) =>
      group.includes(this.phase || ''),
    );

    const valid =
      Number.isFinite(m.total) &&
      typeof m.total === 'number' &&
      m.total > 0 &&
      typeof m.processed === 'number' &&
      Number.isFinite(m.processed) &&
      m.processed >= 0;

    const progress = valid
      ? Math.min(100, Math.max(0, (100 * m.processed!) / m.total!))
      : undefined;

    const elapsed = this.measuredAt - this.scopeStarted;
    const advanced = (m.processed ?? 0) - this.initial;

    const remaining =
      valid &&
      elapsed >= 1000 &&
      advanced > 0 &&
      now - this.lastAdvance < 10000 &&
      m.processed! < m.total!
        ? (elapsed * (m.total! - m.processed!)) / advanced
        : undefined;

    const chat =
      m.chatIndex && m.chatTotal
        ? ` · Chat ${m.chatIndex} of ${m.chatTotal}`
        : '';

    const state =
      valid && m.processed! >= m.total!
        ? 'Step complete'
        : now - this.lastAdvance >= 10000 && valid
          ? `No measured progress for ${duration(now - this.lastAdvance)}`
          : remaining !== undefined
            ? `About ${duration(Math.max(1000, Math.ceil(remaining / 1000) * 1000))} left in this ${m.file && !m.scope ? 'file' : 'step'}`
            : valid
              ? 'Measuring processing speed…'
              : this.phase === 'backup'
                ? 'Backup duration is not reported by SQLite'
                : this.phase === 'collect'
                  ? 'Discovering dependencies; total not yet known'
                  : 'Time remaining unavailable for this step';

    const counts = valid
      ? ` · ${m.processed!.toLocaleString('en-US')} / ${m.total!.toLocaleString('en-US')} ${m.unit || 'items'}`
      : Number.isFinite(m.processed)
        ? ` · ${m.processed!.toLocaleString('en-US')} ${m.unit || 'items'} processed`
        : '';

    return {
      progress,
      stageLabel: `Stage ${Math.max(0, index) + 1} of ${steps[this.kind].length}${chat}`,
      currentItem: [m.chatName, m.file].filter(Boolean).join(' · '),
      timingLabel: `Elapsed ${duration(now - this.started)} · ${state}${counts}`,
    };
  }
}
