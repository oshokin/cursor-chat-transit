import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { busyTimeoutCommand } from './sqlite';
import { SqliteError } from './types';

/** Serialized sqlite3 connection with bounded replies and an owned child lifetime. */
export class SqliteSession {
  /** Marker that ends one SQL reply. */
  private readonly nonce = randomBytes(16).toString('hex');
  /** Stdout not yet split into lines. */
  private buffer = '';
  /** Tail of sqlite stderr. */
  private stderr = '';
  /** Previous statement on this connection. */
  private chain: Promise<unknown> = Promise.resolve();
  /** Error that ended the session. */
  private failure?: Error;
  /** True after the child has exited. */
  private closed = false;
  /** Resolves when the child closes. */
  private readonly exited: Promise<void>;
  /** Wall-clock limit for the statement in flight. */
  private timer?: NodeJS.Timeout;
  /** Delay before the child is killed after stop. */
  private killTimer?: NodeJS.Timeout;
  /** Reply expected for the statement in flight. */
  private waiter?: {
    resolve: (text: string) => void;
    reject: (error: Error) => void;
    text: string;
    onLine?: (line: string) => void;
  };
  /** Stop the session when the caller aborts. */
  private readonly abort = () =>
    this.stop(
      this.signal?.reason instanceof Error
        ? this.signal.reason
        : new Error('Cancelled'),
    );

  /** Own one sqlite3 child. Use `open`. */
  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly signal?: AbortSignal,
    private readonly timeoutMs = 120000,
  ) {
    this.exited = new Promise((resolve) =>
      child.once('close', () => {
        this.closed = true;
        clearTimeout(this.timer);
        clearTimeout(this.killTimer);
        this.signal?.removeEventListener('abort', this.abort);

        const busy = /database is locked|database is busy|SQLITE_BUSY/i.test(
          this.stderr,
        );

        const error = new SqliteError(
          busy
            ? 'SQLite database is busy. Wait for the other operation to finish, then retry.'
            : 'SQLite session stopped before completing its request.',
        );

        error.stderr = this.stderr.trim();
        if (busy) error.code = 'SQLITE_BUSY';
        this.failure ??= error;
        this.waiter?.reject(this.failure);
        this.waiter = undefined;
        resolve();
      }),
    );

    child.on('error', (error) => this.stop(error));
    child.stdin.on('error', (error) => this.stop(error));
    child.stdout.setEncoding('utf8');

    child.stdout.on('data', (chunk: string) => {
      try {
        this.onStdout(chunk);
      } catch (error) {
        this.stop(error instanceof Error ? error : new Error(String(error)));
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString('utf8')).slice(-4000);
    });

    signal?.addEventListener('abort', this.abort, { once: true });
    if (signal?.aborted) this.abort();
  }

  /** Open without changing the database journal or locking mode. */
  static async open(opts: {
    executable: string;
    database: string;
    readOnly?: boolean;
    initFile: string;
    signal?: AbortSignal;
    busyTimeoutMs?: number;
    timeoutMs?: number;
  }): Promise<SqliteSession> {
    opts.signal?.throwIfAborted();

    const child = spawn(
      opts.executable,
      [
        '-init',
        opts.initFile,
        '-batch',
        '-bail',
        ...(opts.readOnly ? ['-readonly'] : []),
        opts.database,
      ],
      { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );

    const session = new SqliteSession(child, opts.signal, opts.timeoutMs);

    try {
      await session.exec(
        `${busyTimeoutCommand(opts.busyTimeoutMs ?? 5000)}\nPRAGMA cache_size=-2000; PRAGMA temp_store=FILE; PRAGMA foreign_keys=ON;`,
      );

      return session;
    } catch (error) {
      await session.close();

      throw error;
    }
  }

  /** Serialize a statement and collect its bounded result. */
  exec(sql: string): Promise<string> {
    return this.enqueue(sql);
  }

  /** Consume result rows without retaining the whole result. */
  queryLines(sql: string, onLine: (line: string) => void): Promise<void> {
    return this.enqueue(sql, onLine).then(() => undefined);
  }

  /** Wait for child exit; never return while it can still hold a database lock. */
  async close(): Promise<void> {
    if (!this.closed) {
      this.child.stdin.end();
      this.killTimer ??= setTimeout(() => this.child.kill('SIGKILL'), 2000);
    }

    await this.exited;
  }

  /** Fail the current query and kill the sqlite child. */
  private stop(error: Error): void {
    this.failure ??= error;
    clearTimeout(this.timer);
    this.waiter?.reject(this.failure);
    this.waiter = undefined;
    if (this.closed) return;
    this.child.kill();
    this.killTimer ??= setTimeout(() => this.child.kill('SIGKILL'), 2000);
  }

  /** Run SQL after the previous statement on this connection. */
  private enqueue(
    sql: string,
    onLine?: (line: string) => void,
  ): Promise<string> {
    const run = this.chain.then(() => {
      if (this.failure || this.closed)
        throw this.failure || new Error('SQLite is closed.');

      return new Promise<string>((resolve, reject) => {
        this.waiter = { resolve, reject, text: '', onLine };

        this.timer = setTimeout(
          () => this.stop(new Error('SQLite operation timed out.')),
          this.timeoutMs,
        );

        this.child.stdin.write(
          `${sql}\nSELECT 'CCTEND${this.nonce}';\n`,
          (error) => {
            if (error) this.stop(error);
          },
        );
      });
    });

    this.chain = run.catch(() => undefined);

    return run;
  }

  /** Split sqlite stdout into result lines and the end marker. */
  private onStdout(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > 4 * 1024 * 1024)
      throw new Error('SQLite result row exceeds 4 MiB.');

    for (;;) {
      const nl = this.buffer.indexOf('\n');

      if (nl < 0) return;
      const line = this.buffer.slice(0, nl).replace(/\r$/, '');

      this.buffer = this.buffer.slice(nl + 1);

      if (line === `CCTEND${this.nonce}`) {
        clearTimeout(this.timer);
        const waiter = this.waiter;

        this.waiter = undefined;
        waiter?.resolve(waiter.text);
      } else if (this.waiter?.onLine) this.waiter.onLine(line);
      else if (this.waiter) {
        this.waiter.text += `${line}\n`;
        if (this.waiter.text.length > 4 * 1024 * 1024)
          throw new Error(
            'SQLite collected result exceeds 4 MiB; use queryLines.',
          );
      }
    }
  }
}
