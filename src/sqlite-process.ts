import { spawn, type ChildProcess } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable, type Writable } from 'node:stream';
import { sqliteTimeoutError } from './sqlite-timeout';
import { SqliteError } from './types';

/** sqlite3 child process: executable, database, streams, and cancellation. */
export interface RunSqliteOptions {
  /** Absolute path of the sqlite3 executable. */
  executable: string;
  database: string;
  /** sqlite3 `-init` file that sets timeouts and modes. */
  initFile: string;
  /** SQL text or a readable stream of SQL. */
  input: string | NodeJS.ReadableStream;
  /** Destination for sqlite3 stdout. */
  output: Writable;
  /** When true, open the database read-only. */
  readOnly?: boolean;
  /** Wall-clock limit for this child. */
  timeoutMs?: number;
  /** Cancellation for the child process. */
  signal?: AbortSignal;
}

/**
 * Stop a sqlite3 child.
 * `child.kill()` does not stop a Windows process started with `windowsHide`,
 * so a timed-out statement keeps running until the query itself finishes.
 */
export function killSqliteChild(
  /** sqlite3 process to stop. */
  child: ChildProcess,
  /** Use SIGKILL. Windows always force-kills the process tree. */
  force = false,
): void {
  if (process.platform !== 'win32') {
    child.kill(force ? 'SIGKILL' : undefined);

    return;
  }

  const pid = child.pid;

  if (pid === undefined) return;

  const killer = spawn('taskkill', ['/F', '/T', '/PID', String(pid)], {
    windowsHide: true,
    stdio: 'ignore',
    shell: false,
  });

  killer.unref();

  killer.once('error', () => {
    child.kill();
  });
}

/** Run sqlite3 with `-batch -bail` and stream stdin/stdout until the child exits. */
export async function runSqlite(
  /** {
  executable,
  database,
  init file,
  input,
  output,
  read only = true,
  timeout ms = 120000,
  signal,
}. */
  {
    executable,
    database,
    initFile,
    input,
    output,
    readOnly = true,
    timeoutMs = 120000,
    signal,
  }: RunSqliteOptions,
): Promise<void> {
  if (!executable || !database || !initFile || !output) {
    throw new TypeError('Missing transport option');
  }

  if (signal?.aborted) throw signal.reason || new Error('Cancelled');

  const child = spawn(
    executable,
    [
      '-init',
      initFile,
      '-batch',
      '-bail',
      ...(readOnly ? ['-readonly'] : []),
      database,
    ],
    { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
  );

  const streamsAbort = new AbortController();
  let spawnError: Error | undefined;
  let stoppingReason: unknown;
  let stderr = Buffer.alloc(0);
  let escalation: NodeJS.Timeout | undefined;

  child.on('error', (error) => {
    spawnError = error;
  });

  child.stderr.on('data', (chunk: Buffer) => {
    stderr = Buffer.concat([stderr, chunk]).subarray(-32768);
  });

  const closed = new Promise<{
    /** Exit code, or null when the process was killed by a signal. */
    code: number | null;
    /** Terminating signal, or null on a normal exit. */
    sig: NodeJS.Signals | null;
  }>((resolve) =>
    child.once(
      'close',
      (
        /** Exit code, or null when the child was signaled. */
        code,
        /** Signal that stopped the child, when it did not exit. */
        sig,
      ) => resolve({ code, sig }),
    ),
  );

  /** Abort pipelines and escalate from SIGTERM to SIGKILL. */
  const stop = (
    /** Why the child is being stopped. */
    reason: unknown,
  ) => {
    if (stoppingReason) return;
    stoppingReason = reason;
    streamsAbort.abort(reason instanceof Error ? reason : undefined);
    killSqliteChild(child);
    escalation = setTimeout(() => killSqliteChild(child, true), 2000);
    escalation.unref();
  };

  /** Stop the child when the caller aborts this SQLite invocation. */
  const abort = () => stop(signal?.reason || new Error('Cancelled'));

  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();

  const timer = setTimeout(
    () => stop(sqliteTimeoutError(timeoutMs, database)),
    timeoutMs,
  );

  timer.unref();

  const source =
    typeof input === 'string' ? Readable.from([input]) : (input as Readable);

  if (!child.stdin || !child.stdout) {
    killSqliteChild(child, true);

    throw new Error('SQLite stdio missing');
  }

  const pumping = Promise.all([
    pipeline(source, child.stdin, { signal: streamsAbort.signal }),
    pipeline(child.stdout, output, { signal: streamsAbort.signal }),
  ]);

  const handled = pumping.catch((error: unknown) => {
    stop(error);

    throw error;
  });

  try {
    const [streams, exit] = await Promise.allSettled([handled, closed]);

    if (spawnError) throw spawnError;
    if (stoppingReason) throw stoppingReason;
    if (streams.status === 'rejected') throw streams.reason;
    if (exit.status !== 'fulfilled') throw exit.reason;
    const { code, sig } = exit.value;

    if (code !== 0 || sig) {
      const error = new SqliteError(
        `SQLite failed (exit=${code}, signal=${sig || 'none'})`,
      );

      error.code = code ?? undefined;
      error.stderr = stderr.toString('utf8');

      throw error;
    }
  } finally {
    clearTimeout(timer);
    if (escalation) clearTimeout(escalation);
    signal?.removeEventListener('abort', abort);
  }
}
