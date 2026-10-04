import { MAX_SQLITE_VALUE_BYTES } from './bundle-limits';
import { bubbleRange, sqlText } from './core';
import { inspectDatabase } from './db';
import { resolveComposers, type HeaderSource } from './db-headers';
import { verifyGlobalSelection } from './deletion-ownership';
import { openReadTransaction } from './read-transaction';
import type { SqliteSession } from './sqlite-session';
import { connOf } from './transfer-context';
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

  const hex = (
    await session.exec(
      `SELECT hex(value) FROM ${schema}.ItemTable WHERE key=${sqlText(key)};`,
    )
  ).trim();

  if (hex) {
    const value = JSON.parse(
      Buffer.from(hex, 'hex').toString('utf8'),
    ) as Record<string, unknown>;

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

      value.allComposers = (
        composers as Array<{
          composerId: string;
        }>
      ).filter((row) => !ids.has(row.composerId));
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

/** Bound IPC requests while preserving indexed range deletes; never scan the whole KV table. */
export async function deleteMessageRows(
  session: SqliteSession,
  /** Composer ids selected for this operation. */
  ids: string[],
  signal?: AbortSignal,
): Promise<void> {
  const batchSize = 64;

  for (let start = 0; start < ids.length; start += batchSize) {
    signal?.throwIfAborted();
    const batch = ids.slice(start, start + batchSize);

    const predicates = batch.map((id) => {
      const range = bubbleRange(id);

      return `key=${sqlText(`composerData:${id}`)} OR (key>=${sqlText(range.lower)} AND key<${sqlText(range.upper)})`;
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
            `SELECT EXISTS(SELECT 1 FROM main.cursorDiskKV WHERE ${where} LIMIT 1);`,
        )
        .join('\n'),
    );

    if (
      remaining
        .trim()
        .split(/\s+/)
        .some((value) => value !== '0')
    )
      throw new Error('Deletion verification failed; transaction rolled back.');
  }
}
