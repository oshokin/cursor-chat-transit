import { MAX_SQLITE_VALUE_BYTES } from './bundle-limits';
import { withoutDeletedSubagents } from './chat-family';
import { bubbleRange, sqlText } from './core';
import { inspectDatabase } from './db';
import { resolveComposers, type HeaderSource } from './db-headers';
import { verifyGlobalSelection } from './deletion-ownership';
import { openReadTransaction } from './read-transaction';
import type { SqliteSession } from './sqlite-session';
import { connOf } from './transfer-context';
import { SQLITE_PARAMETER_BATCH_ROWS } from './sqlite-protocol';
import type {
  ComposerHeader,
  Layout,
  TransferContext,
  WorkspaceEntry,
} from './types';

/** Recheck supported schemas and selected index rows while both target databases are write-locked. */
export async function checkDeletionTransaction(
  /** Transfer hooks, timeouts, and cancellation. */
  ctx: TransferContext,
  workspace: WorkspaceEntry,
  session: SqliteSession,
  /** Composer ids selected for this operation. */
  ids: Set<string>,
  expectedGlobal: HeaderSource[],
  expectedHeaders: ComposerHeader[],
): Promise<{
  /** Layout of the global database. */
  global: Layout;
  /** Layout of the workspace database. */
  workspace: Layout;
}> {
  const globalConn = { ...connOf(ctx, workspace.globalDbPath, false), session };

  const local = await openReadTransaction(
    connOf(ctx, workspace.workspaceDbPath, true),
  );

  try {
    const global = (await inspectDatabase(globalConn)).layout;
    const ws = await inspectDatabase(local.conn);

    if (
      !global.canWriteGlobal ||
      !ws.layout.canWriteWorkspace ||
      (ws.schema.types.composerHeaders && !ws.layout.composerHeaders)
    )
      throw new Error('Unsupported database schema; deletion rolled back.');

    for (const schema of ['main', 'workspace']) {
      const unsafe = await session.exec(
        `SELECT 1 FROM ${schema}.sqlite_schema WHERE type='trigger' AND tbl_name COLLATE NOCASE IN ('cursorDiskKV','composerHeaders','ItemTable') UNION ALL SELECT 1 FROM ${schema}.sqlite_schema AS s JOIN pragma_foreign_key_list(s.name,${sqlText(schema)}) AS f WHERE s.type='table' AND f."table" COLLATE NOCASE IN ('cursorDiskKV','composerHeaders','ItemTable') LIMIT 1;`,
      );

      if (unsafe.trim())
        throw new Error(
          'Database triggers or foreign-key dependencies prevent deletion.',
        );
    }

    const sources = await verifyGlobalSelection(
      globalConn,
      global,
      expectedGlobal,
      ids,
    );

    const current = await resolveComposers(local.conn, globalConn, {
      storageId: workspace.storageId,
      identity: workspace.identity,
      layoutWs: ws.layout,
      layoutGl: global,
      globalSources: sources,
      strictMetadata: true,
      includeSelectionReferences: true,
    });

    /** Stable JSON of the selected composer headers. */
    const selected = (
      /** Composer headers to sign. */
      rows: ComposerHeader[],
    ) =>
      JSON.stringify(
        rows
          .filter((row) => ids.has(row.composerId))
          .map((row) => JSON.stringify(row))
          .sort(),
      );

    if (selected(current) !== selected(expectedHeaders))
      throw new Error(
        'Selected workspace indices changed. Refresh and select the chats again.',
      );

    return { global, workspace: ws.layout };
  } finally {
    await local.close();
  }
}

/** Update only known chat lists; keep unrelated workspace settings and list fields intact. */
export async function deleteHeaderReferences(
  session: SqliteSession,
  schema: 'main' | 'workspace',
  /** Database layout already inspected. */
  layout: Layout,
  /** Composer ids selected for this operation. */
  ids: Set<string>,
): Promise<void> {
  const key =
    schema === 'main' ? 'composer.composerHeaders' : 'composer.composerData';

  const bytes = Number(
    (
      await session.exec(
        `SELECT coalesce(length(CAST(value AS BLOB)),0) FROM ${schema}.ItemTable WHERE key=${sqlText(key)};`,
      )
    ).trim() || 0,
  );

  if (bytes > MAX_SQLITE_VALUE_BYTES)
    throw new Error('Header metadata exceeds the supported record limit.');

  const raw = await singleBlob(
    session,
    `SELECT CAST(value AS BLOB) FROM ${schema}.ItemTable WHERE key=${sqlText(key)};`,
  );

  if (raw) {
    const value = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;

    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Unsupported header list; deletion rolled back.');

    // Migrated Cursor profiles keep chat rows in composerHeaders and leave
    // this ItemTable value as flags plus selected/focused ids, with no list.
    const composers = value.allComposers;

    if (composers !== undefined) {
      if (
        !Array.isArray(composers) ||
        composers.some(
          (row) =>
            !row ||
            typeof row !== 'object' ||
            typeof (
              row as {
                /** Composer id on an untrusted list row. */
                composerId?: unknown;
              }
            ).composerId !== 'string',
        )
      )
        throw new Error('Unsupported header list; deletion rolled back.');

      const parents: string[] = [];

      value.allComposers = (
        composers as Array<{
          composerId: string;
        }>
      )
        .filter((row) => !ids.has(row.composerId))
        .map((row) => {
          const next = withoutDeletedSubagents(
            row as Record<string, unknown>,
            ids,
          );

          if (next !== row) parents.push(row.composerId);

          return next;
        });

      if (layout.composerHeaders && layout.headerColumns.includes('value'))
        await updateHeaderMembership(session, schema, parents, ids);
    }

    for (const field of ['selectedComposerIds', 'lastFocusedComposerIds']) {
      if (value[field] === undefined) continue;
      if (
        !Array.isArray(value[field]) ||
        (value[field] as unknown[]).some((id) => typeof id !== 'string')
      )
        throw new Error(
          'Unsupported selected chat list; deletion rolled back.',
        );

      value[field] = (value[field] as string[]).filter((id) => !ids.has(id));
    }

    await session.exec(
      `UPDATE ${schema}.ItemTable SET value=${sqlText(JSON.stringify(value))} WHERE key=${sqlText(key)};`,
    );
  }

  if (layout.composerHeaders)
    await session.exec(
      `DELETE FROM ${schema}.composerHeaders WHERE composerId IN (SELECT id FROM selected);`,
    );
}

/** Rewrite a kept composerHeaders.value when it still lists a deleted child. */
async function updateHeaderMembership(
  session: SqliteSession,
  schema: 'main' | 'workspace',
  parents: readonly string[],
  ids: ReadonlySet<string>,
): Promise<void> {
  for (const parent of parents) {
    const raw = await singleBlob(
      session,
      `SELECT CAST(value AS BLOB) FROM ${schema}.composerHeaders WHERE composerId=${sqlText(parent)};`,
    );

    if (!raw) continue;

    if (raw.length > MAX_SQLITE_VALUE_BYTES)
      throw new Error('Header metadata exceeds the supported record limit.');

    const value = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;

    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Unsupported header list; deletion rolled back.');

    const next = withoutDeletedSubagents(value, ids);

    if (next === value) continue;

    await session.exec(
      `UPDATE ${schema}.composerHeaders SET value=${sqlText(JSON.stringify(next))} WHERE composerId=${sqlText(parent)};`,
    );
  }
}

/** Read one ItemTable list when it is inside the supported size. */
async function itemText(
  session: SqliteSession,
  schema: 'main' | 'workspace',
  key: string,
): Promise<string | undefined> {
  const bytes = Number(
    (
      await session.exec(
        `SELECT coalesce(length(CAST(value AS BLOB)),0) FROM ${schema}.ItemTable WHERE key=${sqlText(key)};`,
      )
    ).trim() || 0,
  );

  if (!bytes) return undefined;

  if (bytes > MAX_SQLITE_VALUE_BYTES)
    throw new Error('Header metadata exceeds the supported record limit.');

  const raw = await singleBlob(
    session,
    `SELECT CAST(value AS BLOB) FROM ${schema}.ItemTable WHERE key=${sqlText(key)};`,
  );

  return raw?.toString('utf8');
}

/** Parse a chat list. A non-object value rolls the deletion back. */
function parseHeaderList(text: string): {
  allComposers?: Array<{
    composerId?: unknown;
    subagentInfo?: { parentComposerId?: unknown };
    subagentComposerIds?: unknown;
  }>;
} {
  try {
    const value = JSON.parse(text) as unknown;

    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Unsupported header list; deletion rolled back.');

    return value as {
      allComposers?: Array<{
        composerId?: unknown;
        subagentInfo?: { parentComposerId?: unknown };
        subagentComposerIds?: unknown;
      }>;
    };
  } catch (error) {
    throw new Error('Unsupported header list; deletion rolled back.', {
      cause: error,
    });
  }
}

/** Read one KV value when it is inside the supported size. */
async function kvText(
  session: SqliteSession,
  key: string,
): Promise<string | undefined> {
  const bytes = Number(
    (
      await session.exec(
        `SELECT coalesce(length(CAST(value AS BLOB)),0) FROM main.cursorDiskKV WHERE key=${sqlText(key)};`,
      )
    ).trim() || 0,
  );

  if (!bytes) return undefined;

  if (bytes > MAX_SQLITE_VALUE_BYTES)
    throw new Error('Header metadata exceeds the supported record limit.');

  const raw = await singleBlob(
    session,
    `SELECT CAST(value AS BLOB) FROM main.cursorDiskKV WHERE key=${sqlText(key)};`,
  );

  return raw?.toString('utf8');
}

/** Read one bounded SQLite value without hex expansion or result-set collection. */
async function singleBlob(
  session: SqliteSession,
  sql: string,
): Promise<Buffer | undefined> {
  let found: Buffer | undefined;
  let rows = 0;

  await session.rows(sql, [], (row) => {
    rows += 1;
    if (rows > 1 || row.length !== 1)
      throw new Error('Expected one SQLite metadata value.');
    const value = row[0];

    if (value === null) return;
    found = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
    if (found.length > MAX_SQLITE_VALUE_BYTES)
      throw new Error('Header metadata exceeds the supported record limit.');
  });

  return found;
}

/**
 * Remove deleted children from a kept parent's membership list.
 * The parent row itself stays. Message text is not rewritten.
 */
export async function detachDeletedSubagents(
  session: SqliteSession,
  /** Composer ids selected for this operation. */
  ids: Set<string>,
  signal?: AbortSignal,
): Promise<void> {
  const parents = new Set<string>();

  for (const [schema, key] of [
    ['main', 'composer.composerHeaders'],
    ['workspace', 'composer.composerData'],
  ] as const) {
    const text = await itemText(session, schema, key);

    if (!text) continue;
    const value = parseHeaderList(text);

    for (const row of value.allComposers || []) {
      if (!row || typeof row.composerId !== 'string') continue;
      const parent = row.subagentInfo?.parentComposerId;

      if (
        ids.has(row.composerId) &&
        typeof parent === 'string' &&
        parent &&
        !ids.has(parent)
      )
        parents.add(parent);

      if (
        !ids.has(row.composerId) &&
        Array.isArray(row.subagentComposerIds) &&
        row.subagentComposerIds.some(
          (child) => typeof child === 'string' && ids.has(child),
        )
      )
        parents.add(row.composerId);
    }
  }

  for (const id of ids) {
    signal?.throwIfAborted();
    const text = await kvText(session, `composerData:${id}`);

    if (!text) continue;

    const body = JSON.parse(text) as {
      subagentInfo?: { parentComposerId?: unknown };
    };

    const parent = body.subagentInfo?.parentComposerId;

    if (typeof parent === 'string' && parent && !ids.has(parent))
      parents.add(parent);
  }

  for (const parent of parents) {
    signal?.throwIfAborted();
    const key = `composerData:${parent}`;
    const text = await kvText(session, key);

    if (!text) continue;
    const body = JSON.parse(text) as Record<string, unknown>;
    const next = withoutDeletedSubagents(body, ids);

    if (next === body) continue;

    await session.exec(
      `UPDATE main.cursorDiskKV SET value=${sqlText(JSON.stringify(next))} WHERE key=${sqlText(key)};`,
    );
  }
}

/** Bound IPC requests while preserving indexed range deletes; never scan the whole KV table. */
export async function deleteMessageRows(
  session: SqliteSession,
  /** Composer ids selected for this operation. */
  ids: string[],
  signal?: AbortSignal,
): Promise<void> {
  for (
    let start = 0;
    start < ids.length;
    start += SQLITE_PARAMETER_BATCH_ROWS
  ) {
    signal?.throwIfAborted();
    const batch = ids.slice(start, start + SQLITE_PARAMETER_BATCH_ROWS);

    const predicates = batch.map((id) => {
      const range = bubbleRange(id);

      // The diagnostic key is exact. A longer suffix stays, as with composerData tails.
      return `key=${sqlText(`composerData:${id}`)} OR key=${sqlText(`composerRootWriterDiagnostic:${id}`)} OR (key>=${sqlText(range.lower)} AND key<${sqlText(range.upper)})`;
    });

    await session.exec(
      predicates
        .map(
          (/** SQL predicate for one composer. */ where) =>
            `DELETE FROM main.cursorDiskKV WHERE ${where};`,
        )
        .join('\n'),
    );

    const remaining = await session.exec(
      predicates
        .map(
          (/** SQL predicate for one composer. */ where) =>
            `SELECT EXISTS(SELECT 1 FROM main.cursorDiskKV WHERE ${where} LIMIT 1)`,
        )
        .join(' UNION ALL '),
    );

    if (
      remaining.trim().split(/\s+/).length !== batch.length ||
      remaining
        .trim()
        .split(/\s+/)
        .some((value) => value !== '0')
    )
      throw new Error('Deletion verification failed; transaction rolled back.');
  }
}
