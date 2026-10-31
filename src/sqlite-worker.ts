import { NativeDatabase } from './sqlite-native';
import type { SqlRow } from './sqlite-native';
import type { SqlReply, SqlRequest } from './sqlite-protocol';

let engine: NativeDatabase | undefined;
let iterator: IterableIterator<SqlRow> | undefined;

function send(reply: SqlReply): void {
  if (process.connected) process.send?.(reply);
}

function shutdown(): void {
  iterator?.return?.();
  iterator = undefined;
  engine?.close();
  engine = undefined;
}

function batch(): void {
  const rows: SqlRow[] = [];
  let bytes = 0;

  while (iterator && rows.length < 64 && bytes < 1024 * 1024) {
    const next = iterator.next();

    if (next.done) {
      iterator = undefined;
      break;
    }

    const row = next.value;

    rows.push(row);

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
  process.exit(0);
});

process.on('message', (message: SqlRequest) => {
  try {
    if (message.type === 'open') {
      engine = new NativeDatabase(message.options);
      send({ type: 'ready' });
    } else if (message.type === 'query') {
      if (!engine || iterator) throw new Error('Invalid SQLite request state.');
      iterator = engine.rows(message.sql, message.parameters);
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
