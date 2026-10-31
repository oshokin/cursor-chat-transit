import { fork, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sqliteTimeoutError } from './sqlite-timeout';
import { SqliteError } from './types';
import type {
  NativeDatabase,
  NativeOptions,
  SqlParams,
  SqlRow,
} from './sqlite-native';
import type {
  SqlReply,
  SqlSpill,
  SqlWatch,
  SqlWireRow,
} from './sqlite-protocol';
import {
  isSqlSpill,
  SQLITE_COLLECTED_RESULT_BYTES,
  SQLITE_IDLE_WORKER_LIMIT,
  SQLITE_IDLE_WORKER_TIMEOUT_MS,
  SQLITE_INLINE_VALUE_BYTES,
  SQLITE_OPERATION_TIMEOUT_MS,
  SQLITE_WORKER_START_TIMEOUT_MS,
} from './sqlite-protocol';

/** Warm workers have no database handles; limit idle memory and never keep the host alive. */
const idleWorkers: ChildProcess[] = [];
const idleTimers = new WeakMap<ChildProcess, NodeJS.Timeout>();

function releaseWorker(child: ChildProcess): void {
  child.removeAllListeners('message');
  child.removeAllListeners('close');
  child.removeAllListeners('error');
  child.on('error', () => undefined);

  if (!child.connected || idleWorkers.length >= SQLITE_IDLE_WORKER_LIMIT) {
    child.kill('SIGKILL');

    return;
  }

  idleWorkers.push(child);
  child.unref();
  child.channel?.unref();

  const timer = setTimeout(() => {
    const index = idleWorkers.indexOf(child);

    if (index >= 0) idleWorkers.splice(index, 1);
    child.kill('SIGKILL');
  }, SQLITE_IDLE_WORKER_TIMEOUT_MS);

  timer.unref();
  idleTimers.set(child, timer);
}

/** Native SQL runs directly only when an independent parent owns its watchdog. */
let supervised = false;
let requestSequence = 0;

/** Enable direct SQLite inside the transfer worker, never in the extension host. */
export function superviseSqlite(): void {
  supervised = true;
}

/** Options shared by application connections. */
export interface SessionOptions extends NativeOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxLineBytes?: number;
}

/** Owned native connection with serialized requests, bounded rows, cancellation and rollback. */
export class SqliteSession {
  private chain: Promise<unknown> = Promise.resolve();
  private native?: NativeDatabase;
  private iterator?: IterableIterator<SqlRow>;
  private child?: ChildProcess;
  private exited: Promise<void> = Promise.resolve();
  private releaseExit?: () => void;
  private failure?: Error;
  private spillDir?: string;
  private closed = false;
  private waiter?: {
    resolve: () => void;
    reject: (error: Error) => void;
    rows: (rows: SqlRow[]) => Promise<void>;
  };
  private consuming: Promise<void> = Promise.resolve();
  private readonly abort = () =>
    this.stop(
      this.options.signal?.reason instanceof Error
        ? this.options.signal.reason
        : new Error('Cancelled'),
    );

  private constructor(private readonly options: SessionOptions) {}

  /** Open a native connection; standalone callers receive their own supervised SQLite process. */
  static async open(options: SessionOptions): Promise<SqliteSession> {
    options.signal?.throwIfAborted();
    const session = new SqliteSession(options);

    options.signal?.addEventListener('abort', session.abort, { once: true });

    try {
      if (supervised) {
        const { NativeDatabase } = await import('./sqlite-native');

        session.native = session.watch(() => new NativeDatabase(options));
      } else await session.openChild();

      return session;
    } catch (error) {
      await session.close();

      throw error;
    }
  }

  /** Execute one statement or a result-free schema/transaction script. */
  exec(sql: string, parameters: SqlParams = []): Promise<string> {
    return this.text(sql, parameters, '|');
  }

  /** Collect a bounded metadata response with an explicit display separator. */
  text(
    sql: string,
    parameters: SqlParams = [],
    separator = '|',
  ): Promise<string> {
    let text = '';

    return this.rows(sql, parameters, (row) => {
      text += row.map(cellText).join(separator) + '\n';
      if (Buffer.byteLength(text) > SQLITE_COLLECTED_RESULT_BYTES)
        throw new Error('SQLite collected result exceeds 4 MiB; use rows.');
    }).then(() => text);
  }

  /** Compatibility for small JSON metadata queries; large payloads use typed rows. */
  queryLines(
    sql: string,
    onLine: (line: string) => unknown | Promise<unknown>,
    parameters: SqlParams = [],
  ): Promise<void> {
    return this.rows(sql, parameters, async (row) => {
      const line = row.map(cellText).join('|');

      if (
        Buffer.byteLength(line) >
        (this.options.maxLineBytes ?? SQLITE_COLLECTED_RESULT_BYTES)
      )
        throw new Error('SQLite result row exceeds the configured byte limit.');
      await onLine(line);
    });
  }

  /** Await every row consumer before advancing; iterator cleanup precedes failure propagation. */
  rows(
    sql: string,
    parameters: SqlParams,
    onRow: (row: SqlRow) => void | Promise<void>,
  ): Promise<void> {
    const run = this.chain.then(async () => {
      this.check();
      let timer: NodeJS.Timeout | undefined;

      try {
        if (this.native) {
          const request = this.startWatch();
          let iterator: IterableIterator<SqlRow> | undefined;

          try {
            iterator = this.native.rows(sql, parameters);
            this.iterator = iterator;

            for (;;) {
              this.check();
              const next = iterator.next();

              if (next.done) break;
              this.consuming = Promise.resolve().then(() => onRow(next.value));
              await this.consuming;
            }
          } finally {
            iterator?.return?.();
            this.iterator = undefined;
            this.endWatch(request);
          }
        } else {
          timer = setTimeout(
            () =>
              this.stop(
                sqliteTimeoutError(
                  this.options.timeoutMs ?? SQLITE_OPERATION_TIMEOUT_MS,
                  this.options.database,
                ),
              ),
            this.options.timeoutMs ?? SQLITE_OPERATION_TIMEOUT_MS,
          );

          await new Promise<void>((resolve, reject) => {
            this.waiter = {
              resolve,
              reject,
              rows: async (rows) => {
                for (const row of rows) {
                  this.check();
                  await onRow(row);
                }
              },
            };

            this.sendQuery(sql, parameters).catch((error) => {
              if (error) this.stop(error);
            });
          });
        }

        this.check();
      } catch (error) {
        this.stop(error instanceof Error ? error : new Error(String(error)));
        await this.exited;
        await this.consuming;

        throw this.failure;
      } finally {
        clearTimeout(timer);
      }
    });

    this.chain = run.catch(() => undefined);

    return run;
  }

  /** Close idempotently and do not return while a consumer or writer remains active. */
  async close(): Promise<void> {
    if (this.closed) {
      await this.exited;
      await this.consuming;

      return;
    }

    this.closed = true;
    this.options.signal?.removeEventListener('abort', this.abort);
    if (this.waiter) this.stop(new Error('SQLite connection closed.'));
    this.iterator?.return?.();
    this.native?.close();
    if (this.child?.connected)
      this.child.send({ type: 'close' }, () => undefined);
    await this.exited;
    await this.consuming;
    await this.chain;
    if (this.spillDir)
      await rm(this.spillDir, { recursive: true, force: true });
  }

  private startWatch(): SqlWatch {
    const event: SqlWatch = {
      type: 'sqlite-start',
      requestId: ++requestSequence,
      timeoutMs: this.options.timeoutMs ?? SQLITE_OPERATION_TIMEOUT_MS,
    };

    if (process.connected) process.send?.(event);

    return event;
  }

  private endWatch(event: SqlWatch): void {
    if (process.connected) process.send?.({ ...event, type: 'sqlite-end' });
  }

  private watch<T>(run: () => T): T {
    const event = this.startWatch();

    try {
      return run();
    } finally {
      this.endWatch(event);
    }
  }

  private check(): void {
    if (this.failure) throw this.failure;
    if (this.closed) throw new Error('SQLite is closed.');
    this.options.signal?.throwIfAborted();
  }
  private stop(error: Error): void {
    this.failure ??= error;
    this.iterator?.return?.();
    this.native?.close();
    this.child?.kill('SIGKILL');
    this.waiter?.reject(this.failure);
    this.waiter = undefined;
  }
  private async openChild(): Promise<void> {
    const compiled = path.join(__dirname, 'sqlite-worker.js');

    const script = fs.existsSync(compiled)
      ? compiled
      : path.join(__dirname, 'sqlite-worker.ts');

    let child = idleWorkers.pop();

    if (child) {
      clearTimeout(idleTimers.get(child));

      if (!child.connected) child = undefined;
      else {
        child.ref();
        child.channel?.ref();
        child.removeAllListeners('error');
      }
    }

    child ??= fork(script, [], {
      execArgv: script.endsWith('.ts') ? ['--import', 'tsx'] : [],
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });

    this.child = child;

    const owned = child;

    this.exited = new Promise<void>((resolve) => {
      this.releaseExit = resolve;

      owned.once('close', () => {
        this.failure ??= new Error(
          'SQLite worker stopped before completing its request.',
        );

        this.waiter?.reject(this.failure);
        this.waiter = undefined;
        resolve();
      });
    });

    child.on('error', (error) => this.stop(error));
    child.stderr?.resume();

    child.on('message', (message: SqlReply) => {
      if (message.type === 'rows') {
        this.consuming = this.consuming
          .then(async () => {
            const rows: SqlRow[] = [];

            for (const row of message.rows)
              rows.push(await this.readWireRow(row));
            await this.waiter?.rows(rows);
            if (!this.failure && child.connected)
              child.send({ type: 'ack' }, () => undefined);
          })
          .catch((error) => this.stop(error));
      } else if (message.type === 'closed') {
        this.child = undefined;
        this.releaseExit?.();
        releaseWorker(owned);
      } else if (message.type === 'error') {
        const error = new SqliteError(message.message);

        error.stderr = message.message;
        error.code = message.code;
        this.stop(error);
      } else if (message.type === 'ready' || message.type === 'done') {
        const waiter = this.waiter;

        this.waiter = undefined;
        waiter?.resolve();
      }
    });

    const timer = setTimeout(
      () =>
        this.stop(
          sqliteTimeoutError(
            Math.max(
              SQLITE_WORKER_START_TIMEOUT_MS,
              this.options.timeoutMs ?? SQLITE_OPERATION_TIMEOUT_MS,
            ),
          ),
        ),
      Math.max(
        SQLITE_WORKER_START_TIMEOUT_MS,
        this.options.timeoutMs ?? SQLITE_OPERATION_TIMEOUT_MS,
      ),
    );

    try {
      await new Promise<void>((resolve, reject) => {
        this.waiter = { resolve, reject, rows: async () => undefined };

        child.send(
          {
            type: 'open',
            options: {
              database: this.options.database,
              readOnly: this.options.readOnly,
              busyTimeoutMs: this.options.busyTimeoutMs,
              mustExist: this.options.mustExist,
            },
          },
          (error) => {
            if (error) this.stop(error);
          },
        );
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async sendQuery(sql: string, parameters: SqlParams): Promise<void> {
    const wire: Array<SqlParams[number] | SqlSpill> = [];

    for (const value of parameters) {
      const bytes = Buffer.isBuffer(value)
        ? value.length
        : typeof value === 'string'
          ? Buffer.byteLength(value)
          : 0;

      if (bytes <= SQLITE_INLINE_VALUE_BYTES) {
        wire.push(value);
        continue;
      }

      this.spillDir ??= await mkdtemp(path.join(os.tmpdir(), 'cct-sqlite-'));
      const file = path.join(this.spillDir, `${wire.length}-${Date.now()}`);

      await writeFile(file, value as string | Buffer, { flag: 'wx' });

      wire.push({
        type: 'spill',
        path: file,
        byteLength: bytes,
        encoding: Buffer.isBuffer(value) ? 'buffer' : 'utf8',
      });
    }

    await new Promise<void>((resolve, reject) => {
      this.child!.send({ type: 'query', sql, parameters: wire }, (error) =>
        error ? reject(error) : resolve(),
      );
    });
  }

  private async readWireRow(row: SqlWireRow): Promise<SqlRow> {
    const decoded: SqlRow = [];

    for (const value of row) {
      if (!isSqlSpill(value)) {
        decoded.push(value);
        continue;
      }

      const bytes = await readFile(value.path);

      await rm(value.path, { force: true });

      decoded.push(
        value.encoding === 'buffer' ? bytes : bytes.toString('utf8'),
      );
    }

    return decoded;
  }
}

function cellText(value: unknown): string {
  return value === null
    ? ''
    : Buffer.isBuffer(value)
      ? value.toString('utf8')
      : String(value);
}
