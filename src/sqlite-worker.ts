import { NativeDatabase } from './sqlite-native';
import type { SqlRow } from './sqlite-native';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  SqlReply,
  SqlRequest,
  SqlSpill,
  SqlWireRow,
} from './sqlite-protocol';
import {
  isSqlSpill,
  SQLITE_INLINE_VALUE_BYTES,
  SQLITE_PACKET_BYTES,
  SQLITE_PACKET_ROWS,
} from './sqlite-protocol';
import type { SqlParams } from './sqlite-native';

let engine: NativeDatabase | undefined;
let iterator: IterableIterator<SqlRow> | undefined;
const spillDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cct-sqlite-worker-'));

function send(reply: SqlReply): void {
  if (process.connected) process.send?.(reply);
}

function shutdown(): void {
  iterator?.return?.();
  iterator = undefined;
  engine?.close();
  engine = undefined;
}

function spill(value: string | Buffer): SqlSpill {
  const file = path.join(
    spillDir,
    `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );

  fs.writeFileSync(file, value, { flag: 'wx' });

  return {
    type: 'spill',
    path: file,
    byteLength: Buffer.byteLength(value),
    encoding: Buffer.isBuffer(value) ? 'buffer' : 'utf8',
  };
}

function wireRow(row: SqlRow): SqlWireRow {
  return row.map((value) => {
    if (Buffer.isBuffer(value) && value.length > SQLITE_INLINE_VALUE_BYTES)
      return spill(value);
    if (
      typeof value === 'string' &&
      Buffer.byteLength(value) > SQLITE_INLINE_VALUE_BYTES
    )
      return spill(value);

    return value;
  });
}

function batch(): void {
  const rows: SqlWireRow[] = [];
  let bytes = 0;

  while (
    iterator &&
    rows.length < SQLITE_PACKET_ROWS &&
    bytes < SQLITE_PACKET_BYTES
  ) {
    const next = iterator.next();

    if (next.done) {
      iterator = undefined;
      break;
    }

    const row = next.value;

    rows.push(wireRow(row));

    bytes += row.reduce<number>(
      (n, v) =>
        n +
        (Buffer.isBuffer(v)
          ? v.length
          : typeof v === 'string'
            ? Buffer.byteLength(v)
            : 8),
      0,
    );
  }

  if (rows.length) send({ type: 'rows', rows });
  else send({ type: 'done' });
}

process.once('disconnect', () => {
  shutdown();
  fs.rmSync(spillDir, { recursive: true, force: true });
  process.exit(0);
});

process.on('message', (message: SqlRequest) => {
  try {
    if (message.type === 'open') {
      engine = new NativeDatabase(message.options);
      send({ type: 'ready' });
    } else if (message.type === 'query') {
      if (!engine || iterator) throw new Error('Invalid SQLite request state.');

      const parameters: SqlParams = message.parameters.map((value) => {
        if (!isSqlSpill(value)) return value;
        const bytes = fs.readFileSync(value.path);

        fs.rmSync(value.path, { force: true });

        return value.encoding === 'buffer' ? bytes : bytes.toString('utf8');
      });

      iterator = engine.rows(message.sql, parameters);
      batch();
    } else if (message.type === 'ack') batch();
    else if (message.type === 'close') {
      shutdown();
      send({ type: 'closed' });
    }
  } catch (error) {
    shutdown();

    send({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
      code:
        error && typeof error === 'object' && 'code' in error
          ? String(error.code)
          : undefined,
    });
  }
});
