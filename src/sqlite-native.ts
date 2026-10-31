import type Database from 'better-sqlite3';
import { sqliteBinding } from './sqlite-binding';
import {
  SQLITE_BUSY_TIMEOUT_MS,
  SQLITE_MAX_BUSY_TIMEOUT_MS,
  SQLITE_PREPARED_SQL_CHARS,
  SQLITE_PREPARED_STATEMENT_LIMIT,
} from './sqlite-protocol';
import { SqliteError } from './types';

/** SQLite cache retained per native connection, in KiB. */
const SQLITE_CACHE_KIB = 2_000;

/** Parameters and rows cross IPC as typed values, never hex protocol text. */
export type SqlValue = string | number | bigint | Buffer | null;
/** Positional bindings for one prepared statement. */
export type SqlParams = SqlValue[];
/** SQLite result in column order. */
export type SqlRow = SqlValue[];
/** Connection policy captured once for an operation. */
export interface NativeOptions {
  database: string;
  readOnly?: boolean;
  busyTimeoutMs?: number;
  mustExist?: boolean;
}

/** Small synchronous engine, owned only by a supervised worker process. */
export class NativeDatabase {
  private readonly db: Database.Database;
  private readonly prepared = new Map<string, Database.Statement>();

  constructor(options: NativeOptions) {
    const timeout = options.busyTimeoutMs ?? SQLITE_BUSY_TIMEOUT_MS;

    if (
      !Number.isInteger(timeout) ||
      timeout < 0 ||
      timeout > SQLITE_MAX_BUSY_TIMEOUT_MS
    )
      throw new TypeError(
        `SQLite busy timeout must be between 0 and ${SQLITE_MAX_BUSY_TIMEOUT_MS} ms.`,
      );

    const Binding = sqliteBinding();

    this.db = new Binding(options.database, {
      readonly: options.readOnly === true,
      fileMustExist: options.mustExist === true || options.readOnly === true,
      timeout,
    });

    try {
      this.db.pragma(`cache_size=-${SQLITE_CACHE_KIB}`);
      this.db.pragma('temp_store=FILE');
      this.db.pragma('foreign_keys=ON');
      this.db.pragma('synchronous=FULL');
    } catch (error) {
      this.db.close();

      throw error;
    }
  }

  /** Run schema/transaction scripts. Query results are deliberately discarded. */
  script(sql: string): void {
    try {
      this.db.exec(sql);
      if (/\bATTACH\s+DATABASE\b/i.test(sql)) this.configureAttached();
    } catch (error) {
      this.fail(error);
    }
  }

  /** Execute one statement, returning its iterator or an empty iterator for writes. */
  rows(sql: string, parameters: SqlParams = []): IterableIterator<SqlRow> {
    try {
      let statement = parameters.length ? this.prepared.get(sql) : undefined;

      if (!statement) {
        statement = this.db.prepare(sql);

        if (parameters.length && sql.length <= SQLITE_PREPARED_SQL_CHARS) {
          if (this.prepared.size >= SQLITE_PREPARED_STATEMENT_LIMIT)
            this.prepared.delete(this.prepared.keys().next().value!);
          this.prepared.set(sql, statement);
        }
      }

      if (statement.reader)
        return statement
          .safeIntegers(true)
          .raw()
          .iterate(...parameters) as IterableIterator<SqlRow>;
      statement.run(...parameters);
      if (/^\s*ATTACH\b/i.test(sql)) this.configureAttached();

      return [][Symbol.iterator]();
    } catch (error) {
      if (isMultiStatementError(error) && !parameters.length) {
        this.script(sql);

        return [][Symbol.iterator]();
      }

      return this.fail(error);
    }
  }

  private configureAttached(): void {
    for (const row of this.db.pragma('database_list') as Array<{
      name: string;
    }>) {
      if (row.name === 'temp') continue;
      this.db.pragma(`"${row.name.replace(/"/g, '""')}".synchronous=FULL`);
    }
  }

  /** Preserve the existing fatal-on-SQL-error contract: rollback and poison the connection. */
  fail(error: unknown): never {
    this.close();

    const wrapped = new SqliteError(
      `SQLite: ${error instanceof Error ? error.message : String(error)}`,
    );

    wrapped.stderr = wrapped.message;
    if (error && typeof error === 'object' && 'code' in error)
      wrapped.code = String(error.code);

    throw wrapped;
  }

  /** Release active statements and any uncommitted transaction. */
  close(): void {
    this.prepared.clear();
    if (this.db.open) this.db.close();
  }
}

/** Handle CLI-era SQL scripts without parsing SQL or silently dropping query output. */
export function isMultiStatementError(error: unknown): boolean {
  return (
    error instanceof RangeError &&
    /more than one statement/i.test(error.message)
  );
}

/** Native module metadata, verified without touching a Cursor database. */
export function nativeSqliteVersion(): string {
  const Binding = sqliteBinding();
  const db = new Binding(':memory:');

  try {
    return String(db.prepare('SELECT sqlite_version()').pluck().get());
  } finally {
    db.close();
  }
}
