import { MAX_SQLITE_VALUE_BYTES } from './bundle-limits';
import { SqliteSession } from './sqlite-session';
import { traceIO, transferEvent } from './transfer-events';
import type { SqliteConn } from './types';

/** Own a stable read view without copying the database or changing its journal mode. */
export async function openReadTransaction(conn: SqliteConn): Promise<{
  /** All reads through this connection share one database snapshot. */
  conn: SqliteConn;
  /** Release the snapshot and wait for the SQLite child to exit. Idempotent. */
  close: () => Promise<void>;
}> {
  const session = await SqliteSession.open({
    ...conn,
    readOnly: true,
    maxLineBytes: 2 * MAX_SQLITE_VALUE_BYTES + 65536,
  });

  let closing: Promise<void> | undefined;

  try {
    await traceIO(
      'Open database read transaction',
      { path: conn.database },
      () => session.exec('BEGIN; SELECT count(*) FROM sqlite_schema;'),
    );

    const mode = (await session.exec('PRAGMA journal_mode;')).trim();

    transferEvent({
      action: `Database read transaction uses ${mode} journal mode`,
      status: 'info',
      path: conn.database,
    });

    return {
      conn: { ...conn, readOnly: true, session },
      close: () =>
        (closing ??= traceIO(
          'Close database read transaction',
          { path: conn.database },
          () => session.close(),
        )),
    };
  } catch (error) {
    await session.close();

    throw error;
  }
}
