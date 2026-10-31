import { SqliteSession } from './sqlite-session';
import type { SqliteConn } from './types';

/** Own a short native connection when the caller has not supplied a session. */
export async function withSqlite<T>(
  conn: SqliteConn,
  run: (session: SqliteSession) => Promise<T>,
): Promise<T> {
  const session =
    conn.session ||
    (await SqliteSession.open({ ...conn, readOnly: conn.readOnly !== false }));

  try {
    return await run(session);
  } finally {
    if (!conn.session) await session.close();
  }
}

/** Run one metadata query with explicit tab-separated display output. */
export async function execSql(
  opts: SqliteConn & {
    sql: string;
    readOnly?: boolean;
    parameters?: import('./sqlite-native').SqlParams;
  },
): Promise<string> {
  return withSqlite(opts, (session) =>
    session.text(opts.sql, opts.parameters, '\t'),
  );
}

/** Execute result-free DDL and transaction scripts on an owned writable connection. */
export async function execSqlScript(
  opts: SqliteConn & { sql: string },
): Promise<string> {
  return withSqlite({ ...opts, readOnly: false }, (session) =>
    session.exec(opts.sql),
  );
}

/** Probe the bundled driver in a disposable supervised connection. */
export async function sqliteVersion(signal?: AbortSignal): Promise<string> {
  const session = await SqliteSession.open({ database: ':memory:', signal });

  try {
    return (await session.exec('SELECT sqlite_version();')).trim();
  } finally {
    await session.close();
  }
}

/** Split tab-separated sqlite3 list output into fixed-width rows. */
export function parseListRows(text: string, cols: number): string[][] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  return lines.map((line) => {
    const parts = line.split('\t');

    while (parts.length < cols) parts.push('');

    return parts.slice(0, cols);
  });
}

/** Read raw SQLite values as byte columns without a text/hex transport. */
export async function execSqlByteRows(
  opts: SqliteConn & {
    sql: string;
    parameters?: import('./sqlite-native').SqlParams;
    onRow: (fields: Buffer[]) => void | Promise<void>;
  },
): Promise<void> {
  await withSqlite(opts, (session) =>
    session.rows(opts.sql, opts.parameters || [], (row) =>
      opts.onRow(
        row.map((value) =>
          Buffer.isBuffer(value)
            ? value
            : Buffer.from(value === null ? '' : String(value), 'utf8'),
        ),
      ),
    ),
  );
}
