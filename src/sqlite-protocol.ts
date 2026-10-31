import type { NativeOptions, SqlParams, SqlRow } from './sqlite-native';

/** Requests accepted only over the private parent/child IPC channel. */
export type SqlRequest =
  | { type: 'open'; options: NativeOptions }
  | { type: 'query'; sql: string; parameters: SqlParams }
  | { type: 'ack' }
  | { type: 'close' };
/** Byte-bounded row packets and terminal outcomes. */
export type SqlReply =
  | { type: 'ready' | 'done' | 'closed' }
  | { type: 'rows'; rows: SqlRow[] }
  | { type: 'error'; message: string; code?: string };
/** Watchdog notification; never includes SQL or parameter values. */
export interface SqlWatch {
  type: 'sqlite-start' | 'sqlite-end';
  requestId: number;
  timeoutMs: number;
}
