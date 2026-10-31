import type { NativeOptions, SqlParams, SqlRow } from './sqlite-native';

/** Values larger than this use the private spill-file transport. */
export const SQLITE_INLINE_VALUE_BYTES = 1024 * 1024;
/** Maximum payload and row count in one acknowledged worker packet. */
export const SQLITE_PACKET_BYTES = 1024 * 1024;
/** Maximum rows in one acknowledged worker packet. */
export const SQLITE_PACKET_ROWS = 64;
/** Default operation timeout and minimum worker-start allowance. */
export const SQLITE_OPERATION_TIMEOUT_MS = 120_000;
/** Minimum allowance for starting or opening a worker. */
export const SQLITE_WORKER_START_TIMEOUT_MS = 10_000;
/** Warm-worker retention policy. */
export const SQLITE_IDLE_WORKER_LIMIT = 2;
/** Time a warm SQLite worker remains in the idle pool. */
export const SQLITE_IDLE_WORKER_TIMEOUT_MS = 2_000;
/** Bounded compatibility result collection. */
export const SQLITE_COLLECTED_RESULT_BYTES = 4 * 1024 * 1024;
/** Native connection timeout policy. */
export const SQLITE_BUSY_TIMEOUT_MS = 5_000;
/** Largest accepted native busy-handler timeout. */
export const SQLITE_MAX_BUSY_TIMEOUT_MS = 30_000;
/** Prepared statement cache policy. */
export const SQLITE_PREPARED_SQL_CHARS = 32_768;
/** Maximum cached prepared statements per native connection. */
export const SQLITE_PREPARED_STATEMENT_LIMIT = 128;
/** Conservative row count for generated parameterized SQL batches. */
export const SQLITE_PARAMETER_BATCH_ROWS = 64;

/** Large IPC values travel through private one-shot files instead of one huge JSON message. */
export interface SqlSpill {
  type: 'spill';
  path: string;
  byteLength: number;
  encoding: 'buffer' | 'utf8';
}

/** One ordinary SQLite value or a private spill-file reference. */
export type SqlWireValue = SqlRow[number] | SqlSpill;
/** One row encoded for the private worker protocol. */
export type SqlWireRow = SqlWireValue[];

/** Distinguish a spill descriptor from structured-clone Buffer objects. */
export function isSqlSpill(value: SqlWireValue): value is SqlSpill {
  return (
    !Buffer.isBuffer(value) &&
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    value.type === 'spill'
  );
}

/** Requests accepted only over the private parent/child IPC channel. */
export type SqlRequest =
  | { type: 'open'; options: NativeOptions }
  | {
      type: 'query';
      sql: string;
      parameters: Array<SqlParams[number] | SqlSpill>;
    }
  | { type: 'ack' }
  | { type: 'close' };
/** Byte-bounded row packets and terminal outcomes. */
export type SqlReply =
  | { type: 'ready' | 'done' | 'closed' }
  | { type: 'rows'; rows: SqlWireRow[] }
  | { type: 'error'; message: string; code?: string };
/** Watchdog notification; never includes SQL or parameter values. */
export interface SqlWatch {
  type: 'sqlite-start' | 'sqlite-end';
  requestId: number;
  timeoutMs: number;
}
