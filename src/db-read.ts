import { bubbleRange, sqlText } from './core';
import { validTimestamp } from './activity';
import { bubbleKeySql, detectLayout, readSchema } from './schema';
import { execSql, execSqlHexRows } from './sqlite';
import type { BubbleRecord, ComposerHeader, Layout, SqliteConn } from './types';

/** Decode UTF-8 bytes as JSON, or null if empty. */
export function jsonFromBuf(buf: Buffer): unknown {
  if (!buf.length) return null;

  return JSON.parse(buf.toString('utf8'));
}

/** Decode UTF-8 bytes, or null if empty. */
export function textFromBuf(buf: Buffer): string | null {
  return buf.length ? buf.toString('utf8') : null;
}

/**
 * One ItemTable cell. `absent` is a missing row. `null` and `empty` are stored
 * values and are not the same as a missing row.
 */
export type ItemTextState =
  | {
      /** No row exists for the key. */
      status: 'absent';
    }
  | {
      /** The row exists and its value is SQL NULL. */
      status: 'null';
    }
  | {
      /** The row exists and its value is an empty string or blob. */
      status: 'empty';
    }
  | {
      /** The row holds text or blob bytes. */
      status: 'text';
      /** Those bytes decoded as UTF-8. */
      text: string;
    }
  | {
      /** The value uses a storage class this reader does not accept as text. */
      status: 'unsupported';
      /** SQLite `typeof` result, such as `integer`. */
      storageClass: string;
    };

/** Read one ItemTable cell, keeping absence, NULL, and empty distinct. */
export async function readItemTextState(
  conn: SqliteConn,
  key: string,
): Promise<ItemTextState> {
  const row = (
    await selectHexRows(
      conn,
      `SELECT hex(typeof(value)), hex(value) FROM ItemTable WHERE key = ${sqlText(key)};`,
      2,
    )
  )[0];

  if (!row) return { status: 'absent' };

  const storageClass = textFromBuf(row[0]) || '';

  if (storageClass === 'null') return { status: 'null' };

  if (storageClass !== 'text' && storageClass !== 'blob') {
    return { status: 'unsupported', storageClass };
  }

  const text = textFromBuf(row[1]);

  if (text === null) return { status: 'empty' };

  return { status: 'text', text };
}

/** Narrow unknown JSON to a composer header with a string id. */
export function asComposerHeader(value: unknown): ComposerHeader | null {
  if (
    !value ||
    typeof value !== 'object' ||
    typeof (value as ComposerHeader).composerId !== 'string'
  ) {
    return null;
  }

  return value as ComposerHeader;
}

/** Run a read-only hex query and collect decoded rows. */
export async function selectHexRows(
  conn: SqliteConn,
  sql: string,
  cols: number,
): Promise<Buffer[][]> {
  const rows: Buffer[][] = [];

  await execSqlHexRows({
    ...conn,
    sql,
    cols,
    readOnly: true,
    onRow: (fields) => {
      rows.push(fields);
    },
  });

  return rows;
}

/** Detect tables/columns and map them onto a known layout. */
export async function inspectDatabase(
  conn: SqliteConn,
): Promise<{ schema: Awaited<ReturnType<typeof readSchema>>; layout: Layout }> {
  const schema = await readSchema(conn);
  const layout = detectLayout(schema);

  return { schema, layout };
}

/** Optional test-only overrides; mutating this object is visible across ESM/CJS. */
export const testHooks: {
  /** Override ItemTable text reads in tests. */
  readItemText?: (conn: SqliteConn, key: string) => Promise<string | null>;
  /** Override cursorDiskKV text reads in tests. */
  readKvText?: (conn: SqliteConn, key: string) => Promise<string | null>;
} = {};

/** Read an ItemTable value as UTF-8 text. */
export async function readItemText(
  conn: SqliteConn,
  key: string,
): Promise<string | null> {
  if (testHooks.readItemText) return testHooks.readItemText(conn, key);

  return readItemTextImpl(conn, key);
}

/**
 * Unhooked ItemTable text read, for tests that inject around the public wrapper.
 * An empty string is returned as `''`. A missing row and SQL NULL both return
 * null here; callers that must separate those states use `readItemTextState`.
 */
export async function readItemTextImpl(
  conn: SqliteConn,
  key: string,
): Promise<string | null> {
  const state = await readItemTextState(conn, key);

  if (state.status === 'text') return state.text;
  if (state.status === 'empty') return '';

  return null;
}

/** Read an ItemTable value as a JSON object. */
export async function readItemJson(
  conn: SqliteConn,
  key: string,
): Promise<Record<string, unknown> | null> {
  const raw = await readItemText(conn, key);

  if (raw === null) return null;
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    return null;

  return parsed as Record<string, unknown>;
}

/** Read composerHeaders rows, skipping empty-state drafts. */
export async function readComposerHeadersTable(
  conn: SqliteConn,
  columns?: string[],
  includeColumnDates = false,
): Promise<ComposerHeader[]> {
  const hasWorkspaceId = !columns || columns.includes('workspaceId');

  /** Emit a hex timestamp column, or empty hex when dates stay in JSON. */
  const timestampColumn = (name: string) =>
    includeColumnDates && columns?.includes(name)
      ? `hex(CAST(${name} AS TEXT))`
      : "hex('')";

  const composers: ComposerHeader[] = [];

  await execSqlHexRows({
    ...conn,
    sql: `SELECT hex(composerId), ${hasWorkspaceId ? "hex(COALESCE(workspaceId, ''))" : "hex('')"}, hex(value), ${timestampColumn('createdAt')}, ${timestampColumn('lastUpdatedAt')} FROM composerHeaders;`,
    cols: 5,
    readOnly: true,
    onRow: ([, wsBuf, valueBuf, createdBuf, updatedBuf]) => {
      const parsed = asComposerHeader(jsonFromBuf(valueBuf));

      if (!parsed || parsed.composerId === 'empty-state-draft') return;

      // Some versions keep dates in columns rather than inside the JSON value.
      for (const [key, buffer] of [
        ['createdAt', createdBuf],
        ['lastUpdatedAt', updatedBuf],
      ] as const) {
        const stored = validTimestamp(Number(textFromBuf(buffer)));

        if (!validTimestamp(parsed[key]) && stored) parsed[key] = stored;
      }

      const workspaceId = textFromBuf(wsBuf);

      if (!parsed.workspaceIdentifier && workspaceId) {
        parsed.workspaceIdentifier = { id: workspaceId };
      } else if (
        workspaceId &&
        parsed.workspaceIdentifier &&
        !parsed.workspaceIdentifier.id
      ) {
        parsed.workspaceIdentifier.id = workspaceId;
      }

      composers.push(parsed);
    },
  });

  return composers;
}

/**
 * Workspace id stored in `composerHeaders.workspaceId`, when that column exists.
 * An empty column is `''`. A missing column is null so it is not a JSON id.
 */
export async function composerHeaderWorkspaceColumn(
  conn: SqliteConn,
  columns: string[] | undefined,
  composerId: string,
): Promise<string | null> {
  if (!columns?.includes('workspaceId')) return null;

  const rows = await selectHexRows(
    conn,
    `SELECT hex(CAST(COALESCE(workspaceId, '') AS TEXT)) FROM composerHeaders WHERE composerId = ${sqlText(composerId)};`,
    1,
  );

  if (!rows.length || !rows[0]?.[0]) return '';

  return textFromBuf(rows[0][0]) ?? '';
}

/** How the SQL `isArchived` column classifies one composerHeaders row. */
export type ArchiveColumn =
  'absent' | 'archived' | 'active' | 'invalid' | 'unsupported';

/**
 * Read `composerHeaders.isArchived` when that column exists.
 * `1` is archived, `0` is active, and any other stored value is invalid.
 * A missing column is unsupported rather than an implicit active chat.
 */
export async function composerHeaderArchiveColumn(
  conn: SqliteConn,
  columns: string[] | undefined,
  composerId: string,
): Promise<ArchiveColumn> {
  if (!columns?.includes('isArchived')) return 'unsupported';

  const rows = await selectHexRows(
    conn,
    `SELECT hex(CAST(COALESCE(isArchived, '') AS TEXT)) FROM composerHeaders WHERE composerId = ${sqlText(composerId)};`,
    1,
  );

  if (!rows.length || !rows[0]?.[0]) return 'absent';
  const text = textFromBuf(rows[0][0]);

  if (text === null || text === '') return 'absent';
  if (text === '1') return 'archived';
  if (text === '0') return 'active';

  return 'invalid';
}

/** Read a cursorDiskKV value as UTF-8 text. */
export async function readKvText(
  conn: SqliteConn,
  key: string,
): Promise<string | null> {
  if (testHooks.readKvText) return testHooks.readKvText(conn, key);

  return readKvTextImpl(conn, key);
}

/** Unhooked cursorDiskKV text read, for tests that inject around the public wrapper. */
export async function readKvTextImpl(
  conn: SqliteConn,
  key: string,
): Promise<string | null> {
  const row = (
    await selectHexRows(
      conn,
      `SELECT hex(value) FROM cursorDiskKV WHERE key = ${sqlText(key)};`,
      1,
    )
  )[0];

  if (!row || !row[0]) return null;

  return textFromBuf(row[0]);
}

/** cursorDiskKV payload as raw bytes plus SQLite storage class. */
export interface KvBytes {
  /** How SQLite stored the value. */
  storageClass: 'text' | 'blob';
  /** Raw bytes, not a UTF-8 reinterpretation of a blob. */
  bytes: Buffer;
}

/** Read a cursorDiskKV value as raw bytes and SQLite storage class. */
export async function readKvBytes(
  conn: SqliteConn,
  key: string,
): Promise<KvBytes | null> {
  const row = (
    await selectHexRows(
      conn,
      `SELECT hex(typeof(value)), hex(CAST(value AS BLOB)) FROM cursorDiskKV WHERE key = ${sqlText(key)};`,
      2,
    )
  )[0];

  if (!row || !row[0]) return null;
  const storageClass = textFromBuf(row[0]);

  if (storageClass !== 'text' && storageClass !== 'blob') {
    throw new Error(
      `Unsupported SQLite storage class: ${storageClass || 'empty'}`,
    );
  }

  return { storageClass, bytes: row[1] || Buffer.alloc(0) };
}

/** Read many `agentKv:blob:*` values. Missing keys are omitted. */
export async function readKvBlobs(
  conn: SqliteConn,
  keys: string[],
): Promise<Map<string, KvBytes>> {
  const out = new Map<string, KvBytes>();
  const unique = [...new Set(keys)];

  for (let offset = 0; offset < unique.length; offset += 32) {
    const chunk = unique.slice(offset, offset + 32);

    const sql = chunk
      .map((key) => {
        if (!/^agentKv:blob:[0-9a-f]{64}$/.test(key)) {
          throw new Error('Invalid blob key.');
        }

        const quoted = sqlText(key);

        return `SELECT hex(${quoted}), hex(typeof(value)), hex(CAST(value AS BLOB)) FROM cursorDiskKV WHERE key = ${quoted};`;
      })
      .join('\n');

    const rows = await selectHexRows(conn, sql, 3);

    for (const row of rows) {
      const key = textFromBuf(row[0] || Buffer.alloc(0));
      const storageClass = textFromBuf(row[1] || Buffer.alloc(0));

      if (!key) continue;

      if (storageClass !== 'text' && storageClass !== 'blob') {
        throw new Error(
          `Unsupported SQLite storage class: ${storageClass || 'empty'}`,
        );
      }

      out.set(key, { storageClass, bytes: row[2] || Buffer.alloc(0) });
    }
  }

  return out;
}

/** True if a cursorDiskKV key exists (does not load the value). */
export async function kvExists(
  conn: SqliteConn,
  key: string,
): Promise<boolean> {
  const out = await execSql({
    ...conn,
    sql: `SELECT 1 FROM cursorDiskKV WHERE key = ${sqlText(key)} LIMIT 1;`,
    readOnly: true,
  });

  return out.trim().startsWith('1');
}

/** Decode one `bubbleId:<composerId>:<bubbleId>` hex row. */
export function bubbleFromFields(fields: Buffer[]): BubbleRecord | null {
  const key = textFromBuf(fields[0]);

  if (!key) return null;
  const parts = key.split(':');

  if (parts.length < 3 || parts[0] !== 'bubbleId') return null;
  const value = textFromBuf(fields[2]);

  if (value === null) return null;

  return {
    key,
    value,
    bubbleId: parts.slice(2).join(':'),
  };
}

/** Range-scan bubble rows and await each row so the writer can apply backpressure. */
export async function forEachBubble(
  conn: SqliteConn,
  composerId: string,
  onBubble: (bubble: BubbleRecord) => void | Promise<void>,
): Promise<number> {
  const { sql } = bubbleKeySql(composerId);
  let count = 0;

  await execSqlHexRows({
    ...conn,
    sql,
    cols: 3,
    readOnly: true,
    onRow: async (fields) => {
      const bubble = bubbleFromFields(fields);

      if (!bubble) return;
      count += 1;
      await onBubble(bubble);
    },
  });

  return count;
}

/** Collect bubble IDs for one composer without loading message bodies. */
export async function listBubbleIds(
  conn: SqliteConn,
  composerId: string,
): Promise<Set<string>> {
  const { lower, upper } = bubbleRange(composerId);
  const ids = new Set<string>();

  await execSqlHexRows({
    ...conn,
    sql: `SELECT hex(key) FROM cursorDiskKV WHERE key >= ${sqlText(lower)} AND key < ${sqlText(upper)};`,
    cols: 1,
    readOnly: true,
    onRow: ([keyBuf]) => {
      const key = textFromBuf(keyBuf);

      if (!key) return;
      const parts = key.split(':');

      if (parts.length < 3 || parts[0] !== 'bubbleId') return;
      ids.add(parts.slice(2).join(':'));
    },
  });

  return ids;
}

/** Range-scan bubble rows for one composer. */
export async function readBubbles(
  conn: SqliteConn,
  composerId: string,
): Promise<BubbleRecord[]> {
  const bubbles: BubbleRecord[] = [];

  await forEachBubble(conn, composerId, (bubble) => {
    bubbles.push(bubble);
  });

  return bubbles;
}

/** Mutable read entry points so tests can inject concurrent changes. */
export const reads = {
  readItemText,
  readKvText,
};
