import type { ChildProcess } from 'node:child_process';
import { sqliteTimeoutError } from './sqlite-timeout';
import type { SqlWatch } from './sqlite-protocol';

/** Parent-owned deadlines remain runnable while native SQLite blocks a worker. */
export class SqliteSupervisor {
  private readonly timers = new Map<number, NodeJS.Timeout>();
  private cancelTimer?: NodeJS.Timeout;
  private stopping?: Error;

  constructor(private readonly child: ChildProcess) {}

  /** Accept only bounded private watchdog packets, never SQL or payloads. */
  observe(message: Partial<SqlWatch>): boolean {
    if (message.type !== 'sqlite-start' && message.type !== 'sqlite-end')
      return false;
    if (
      !Number.isSafeInteger(message.requestId) ||
      !message.requestId ||
      !Number.isFinite(message.timeoutMs) ||
      message.timeoutMs! <= 0
    )
      return true;
    const id = message.requestId;

    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    if (message.type === 'sqlite-start')
      this.timers.set(
        id,
        setTimeout(
          () => {
            this.stopping ??= sqliteTimeoutError(message.timeoutMs!);
            this.child.kill('SIGKILL');
          },
          Math.min(message.timeoutMs!, 3600000),
        ),
      );

    return true;
  }

  /** Allow cooperative cleanup, then force termination with a bounded grace period. */
  cancel(graceMs = 2000): void {
    this.cancelTimer ??= setTimeout(() => {
      this.stopping ??= new DOMException('Cancelled', 'AbortError');
      this.child.kill('SIGKILL');
    }, graceMs);
  }

  /** Preserve timeout/cancellation rather than report an unexplained worker exit. */
  reason(): Error | undefined {
    return this.stopping;
  }

  /** Drop every timer at the operation boundary. */
  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    clearTimeout(this.cancelTimer);
  }
}
