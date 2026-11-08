import { inspectDatabase } from './db';
import { MAX_SQLITE_VALUE_BYTES } from './bundle-limits';
import {
  readGlobalHeaderSources,
  resolveComposers,
  type HeaderSource,
  matchesWorkspaceStorage,
  workspaceBinding,
} from './db-headers';
import { indexGlobalHeaders } from './header-index';
import { openReadTransaction } from './read-transaction';
import { connOf } from './transfer-context';
import { traceIO } from './transfer-events';
import type {
  ComposerHeader,
  Layout,
  TransferContext,
  WorkspaceEntry,
} from './types';

/** Scoped header cache shared by metadata operations, never by chat writes. */
export class WorkspaceHeaderReader {
  /** Global header snapshots are reused only within this reader's operation. */
  private readonly cache = new Map<
    string,
    Promise<Awaited<ReturnType<typeof globalHeaders>>>
  >();
  /** Capture settings and cancellation once. */
  constructor(
    /** Transfer hooks, timeouts, and cancellation. */
    private readonly ctx: TransferContext,
    /** Read createdAt from the composer table when the layout has that column. */
    private readonly includeColumnDates = false,
  ) {}
  /** Resolve a physical workspace without loading composer or message bodies. */
  async read(
    /** Workspace whose composer headers are loaded. */
    workspace: WorkspaceEntry,
    /** Require readable indices and include selected/focused references for deletion ownership. */
    forDeletionOwnership = false,
  ): Promise<ComposerHeader[]> {
    this.ctx.signal?.throwIfAborted();
    const metadata = await this.globalMetadata(workspace);

    const local = await openReadTransaction(
      connOf(this.ctx, workspace.workspaceDbPath, true),
    );

    try {
      const { layout, schema } = await inspectDatabase(local.conn);

      if (
        forDeletionOwnership &&
        (!layout.itemTable ||
          (schema.types.composerHeaders && !layout.composerHeaders))
      )
        throw new Error(
          'Unsupported workspace header schema; ownership cannot be verified.',
        );

      const rows = await resolveComposers(
        local.conn,
        connOf(this.ctx, workspace.globalDbPath, true),
        {
          storageId: workspace.storageId,
          identity: workspace.identity,
          layoutWs: layout,
          layoutGl: metadata.layout,
          globalSources: metadata.lookup(workspace),
          strictMetadata: true,
          includeSelectionReferences: forDeletionOwnership,
          includeColumnDates: this.includeColumnDates,
        },
      );

      if (forDeletionOwnership && metadata.layout.cursorDiskKV) {
        const global = await openReadTransaction(
          connOf(this.ctx, workspace.globalDbPath, true),
        );

        try {
          const byId = new Map(rows.map((row) => [row.composerId, row]));

          // Selected/focused ids are UI hints, not catalogue membership. Cursor
          // can leave them behind after moving a chat to another workspace.
          const catalogue = new Set(
            (
              await resolveComposers(
                local.conn,
                connOf(this.ctx, workspace.globalDbPath, true),
                {
                  storageId: workspace.storageId,
                  identity: workspace.identity,
                  layoutWs: layout,
                  layoutGl: metadata.layout,
                  globalSources: [],
                  strictMetadata: true,
                },
              )
            ).map((row) => row.composerId),
          );

          let candidates = 0;

          await global.conn.session!.rows(
            `SELECT CASE WHEN length(CAST(value AS BLOB)) > ${MAX_SQLITE_VALUE_BYTES} THEN NULL
              WHEN json_valid(value) THEN CASE WHEN json_type(value)='object' THEN json_object('composerId', substr(key,14),
              'workspaceIdentifier', json_extract(value,'$.workspaceIdentifier'),
              'name', json_extract(value,'$.name'),
              'subagentInfo', json_extract(value,'$.subagentInfo'),
              'subagentComposerIds', json_extract(value,'$.subagentComposerIds')) END END
             FROM cursorDiskKV WHERE key >= 'composerData:' AND key < 'composerData;'
             AND length(key)=49 AND value IS NOT NULL LIMIT 10001;`,
            [],
            (row) => {
              this.ctx.signal?.throwIfAborted();
              if (++candidates > 10_000)
                throw new Error(
                  'Cannot verify composer family ownership: invalid, oversized, or excessive composer records. No data was deleted.',
                );
              // Opaque unrelated bodies are assessed by history classification;
              // they cannot supply a trustworthy ownership claim here. The
              // destructive transaction independently fails closed on them.
              if (row[0] === null) return;
              const body = JSON.parse(String(row[0])) as ComposerHeader;

              if (
                body.subagentComposerIds !== null &&
                (!Array.isArray(body.subagentComposerIds) ||
                  body.subagentComposerIds.some((id) => typeof id !== 'string'))
              )
                throw new Error(
                  'Cannot verify malformed composer family membership. No data was deleted.',
                );

              const binding = workspaceBinding(
                body,
                workspace.storageId,
                workspace.identity,
              );

              // Folder URIs can be reused by multiple physical workspace stores.
              // A body with an explicit storage id belongs only to that store;
              // the URI fallback in workspaceBinding is not an ownership test.
              if (
                binding === 'match' &&
                matchesWorkspaceStorage(
                  body,
                  workspace.storageId,
                  workspace.identity,
                )
              )
                byId.set(body.composerId, {
                  ...byId.get(body.composerId),
                  ...body,
                });
              else if (
                byId.has(body.composerId) &&
                (binding === 'other' ||
                  binding === 'conflict' ||
                  (binding === 'match' &&
                    !matchesWorkspaceStorage(
                      body,
                      workspace.storageId,
                      workspace.identity,
                    )))
              ) {
                if (binding !== 'conflict' && !catalogue.has(body.composerId)) {
                  byId.delete(body.composerId);

                  return;
                }

                byId.set(body.composerId, {
                  ...byId.get(body.composerId)!,
                  workspaceIdentifier: body.workspaceIdentifier,
                });
              }
            },
          );

          return [...byId.values()];
        } finally {
          await global.close();
        }
      }

      return rows;
    } finally {
      await local.close();
    }
  }
  /** Share the global snapshot with ownership checks instead of querying it a second time. */
  async globalMetadata(
    workspace: WorkspaceEntry,
  ): ReturnType<typeof globalHeaders> {
    let pending = this.cache.get(workspace.globalDbPath);

    if (!pending) {
      pending = globalHeaders(this.ctx, workspace, this.includeColumnDates);
      this.cache.set(workspace.globalDbPath, pending);
    }

    return pending;
  }
}

/** Read global header metadata once for each database in this run. */
async function globalHeaders(
  /** Transfer hooks, timeouts, and cancellation. */
  ctx: TransferContext,
  /** Workspace whose composer headers are loaded from the global database. */
  entry: WorkspaceEntry,
  /** Read createdAt from the composer table when the layout has that column. */
  includeColumnDates: boolean,
): Promise<{
  /** Schema of the opened global database. */
  layout: Layout;
  /** Composer header snapshots stored in cursorDiskKV. */
  sources: HeaderSource[];
  /** Indexed physical-storage lookup for this snapshot only. */
  lookup: ReturnType<typeof indexGlobalHeaders>;
}> {
  const view = await openReadTransaction(connOf(ctx, entry.globalDbPath, true));

  try {
    return await traceIO(
      'Read global chat headers',
      { path: entry.globalDbPath },
      async () => {
        const { layout } = await inspectDatabase(view.conn);

        if (layout.writeBlocked && !layout.cursorDiskKV)
          throw new Error('Unsupported Cursor database schema.');

        const sources = await readGlobalHeaderSources(
          view.conn,
          layout,
          includeColumnDates,
          true,
        );

        return { layout, sources, lookup: indexGlobalHeaders(sources) };
      },
    );
  } finally {
    await view.close();
  }
}
