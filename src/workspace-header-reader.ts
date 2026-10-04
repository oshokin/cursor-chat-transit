import { inspectDatabase } from './db';
import {
  readGlobalHeaderSources,
  resolveComposers,
  type HeaderSource,
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

      return await resolveComposers(
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
