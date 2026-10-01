import { formatLogLine } from './log-format';

/** Host Output panel. Not a log channel: Cursor does not reveal `{ log: true }`. */
export interface TransitLog {
  /** Append one line to the Output channel. */
  appendLine(value: string): void;
  /** Informational line. */
  info(message: string): void;
  /** Warning line. */
  warn(message: string): void;
  /** Error line. */
  error(message: string): void;
  /** Reveal the channel; Cursor ignores show() on log:true channels. */
  show(preserveFocus?: boolean): void;
  /** Dispose the underlying OutputChannel. */
  dispose(): void;
}

/** Output channel that may already color info, warn, and error. */
type HostChannel = {
  /** Append one line to the Output channel. */
  appendLine(value: string): void;
  /** Reveal the channel. Cursor may ignore this on a log channel. */
  show(preserveFocus?: boolean): void;
  /** Dispose the underlying OutputChannel. */
  dispose(): void;
  /** Present when this is a log channel. */
  logLevel?: number;
  /** Colored info line on a log channel. */
  info?(message: string): void;
  /** Colored warning line on a log channel. */
  warn?(message: string): void;
  /** Colored error line on a log channel. */
  error?(message: string): void;
};

/** True when the host channel can color and filter by level. */
function isLogChannel(channel: HostChannel): channel is HostChannel & {
  /** Host log level. Present only on a log channel. */
  logLevel: number;
  /** Colored info line. */
  info(message: string): void;
  /** Colored warning line. */
  warn(message: string): void;
  /** Colored error line. */
  error(message: string): void;
} {
  return (
    typeof channel.logLevel === 'number' &&
    typeof channel.info === 'function' &&
    typeof channel.warn === 'function' &&
    typeof channel.error === 'function'
  );
}

/** Preserve an already formatted operation line; format standalone host messages. */
function formatted(level: 'INFO' | 'WARN' | 'ERROR', message: string): string {
  return /^\[\d{4}-\d\d-\d\d [^\]]+\] \[(INFO|WARN|ERROR)\] /.test(message)
    ? message
    : formatLogLine(level, message);
}

/** Wrap an Output channel. A log channel keeps its own level methods. */
export function asTransitLog(channel: HostChannel): TransitLog {
  if (isLogChannel(channel)) {
    return {
      appendLine: (value) => channel.appendLine(formatted('INFO', value)),
      info: (message) => channel.info(formatted('INFO', message)),
      warn: (message) => channel.warn(formatted('WARN', message)),
      error: (message) => channel.error(formatted('ERROR', message)),
      show: (preserveFocus) => channel.show(preserveFocus),
      dispose: () => channel.dispose(),
    };
  }

  return {
    appendLine: (value) => channel.appendLine(formatted('INFO', value)),
    info: (message) => channel.appendLine(formatted('INFO', message)),
    warn: (message) => channel.appendLine(formatted('WARN', message)),
    error: (message) => channel.appendLine(formatted('ERROR', message)),
    show: (preserveFocus) => channel.show(preserveFocus),
    dispose: () => channel.dispose(),
  };
}

/** Minimum operation-log level from settings. */
type OperationLogLevel = 'info' | 'warn' | 'error';

/** Drop lines below the current setting. The host channel still colors what remains. */
export function gateOperationLog(
  channel: TransitLog,
  level: () => OperationLogLevel,
): TransitLog {
  const rank: Record<OperationLogLevel, number> = {
    info: 0,
    warn: 1,
    error: 2,
  };

  /** True when this severity is at or above the setting. */
  const allow = (messageLevel: OperationLogLevel) =>
    rank[messageLevel] >= rank[level()];

  return {
    appendLine: (value) => channel.appendLine(formatted('INFO', value)),
    info: (message) => {
      if (allow('info')) channel.info(message);
    },
    warn: (message) => {
      if (allow('warn')) channel.warn(message);
    },
    error: (message) => {
      if (allow('error')) channel.error(message);
    },
    show: (preserveFocus) => channel.show(preserveFocus),
    dispose: () => channel.dispose(),
  };
}

/** Let the webview message turn finish before touching the panel. */
export function yieldToHost(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Select this channel in the Output dropdown and focus the Output view.
 * `channel.show` alone does not switch a visible Output tab in Cursor.
 */
export async function revealOutput(
  channel: {
    /** Reveal the channel; Cursor ignores show() on log:true channels. */
    show: (preserveFocus?: boolean) => void;
  },
  host?: {
    /** Run a workbench command such as `workbench.view.output`. */
    executeCommand(command: string): Thenable<unknown>;
    /** Yield so the webview message turn can finish first. */
    yieldToHost?: () => Promise<void>;
  },
): Promise<void> {
  if (host?.yieldToHost) await host.yieldToHost();
  channel.show(true);

  try {
    await host?.executeCommand('workbench.view.output');
  } catch {
    /* older hosts still get the focused show() below */
  }

  channel.show(false);
}
