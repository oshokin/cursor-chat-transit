/** Host Output panel. Not a LogOutputChannel: Cursor ignores show() on `{ log: true }`. */
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

/** Wrap a normal OutputChannel so callers can keep info/warn/error. */
export function asTransitLog(channel: {
  /** Append one line to the Output channel. */
  appendLine(value: string): void;
  /** Reveal the channel; Cursor ignores show() on log:true channels. */
  show(preserveFocus?: boolean): void;
  /** Dispose the underlying OutputChannel. */
  dispose(): void;
}): TransitLog {
  return {
    appendLine: (value) => channel.appendLine(value),
    info: (message) => channel.appendLine(message),
    warn: (message) => channel.appendLine(message),
    error: (message) => channel.appendLine(message),
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
