import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readBundleObject } from './bundle-object';
import { selectChats } from './core';
import * as db from './db';
import { exportBundle } from './export-bundle';
import { connOf, inspectPair } from './transfer-context';
import { openReadTransaction } from './read-transaction';
import type {
  ComposerHeader,
  ExportObject,
  TransferContext,
  WorkspaceEntry,
} from './types';

/** List composer headers for a workspace without loading bubble bodies. */
export async function listWorkspaceChats(
  /** Transfer hooks, timeouts, and cancellation. */
  ctx: TransferContext,
  workspace: WorkspaceEntry,
  options: {
    /** When true, merge timestamp columns from composerHeaders into listed headers. */
    includeColumnDates?: boolean;
    /** Read views owned by the export, when resolving headers for an archive. */
    connections?: {
      /** Workspace header view, released after catalogue resolution. */
      connWs: import('./types').SqliteConn;
      /** Global view shared by headers, bodies, messages and dependencies. */
      connGl: import('./types').SqliteConn;
    };
  } = {},
): Promise<{
  /** Merged composer headers visible in this workspace. */
  allComposers: ComposerHeader[];
  /** Provenance recorded for a later export. */
  source: NonNullable<ExportObject['source']>;
}> {
  const pair = options.connections;

  const { connWs, connGl, wsInfo, glInfo } = pair
    ? {
        ...pair,
        wsInfo: await db.inspectDatabase(pair.connWs),
        glInfo: await db.inspectDatabase(pair.connGl),
      }
    : await inspectPair(ctx, workspace);

  if (glInfo.layout.writeBlocked && !glInfo.layout.cursorDiskKV) {
    throw new Error(
      glInfo.layout.unsupportedReason || 'Unsupported Cursor database schema.',
    );
  }

  const allComposers = await db.resolveComposers(connWs, connGl, {
    storageId: workspace.storageId,
    identity: workspace.identity,
    layoutWs: wsInfo.layout,
    layoutGl: glInfo.layout,
    includeColumnDates: options.includeColumnDates,
  });

  return {
    allComposers,
    source: {
      schema: glInfo.layout.composerHeaders ? 'header-table' : 'legacy',
      workspace: workspace.identity || {
        kind: 'folder',
        uri: { path: workspace.storageId },
      },
    },
  };
}

/** Build an export object for a workspace; missing bodies are listed as incomplete. */
export async function buildExportObject(
  /** Transfer hooks, timeouts, and cancellation. */
  ctx: TransferContext,
  workspace: WorkspaceEntry,
  /** Composer ids to keep. An empty list keeps none. */
  selectedIds?: string[],
): Promise<ExportObject> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cct-object-'));
  const dest = path.join(dir, 'export.cursor-chat.zip');

  try {
    const summary = await exportToFile(ctx, workspace, dest, selectedIds);
    const obj = await readBundleObject(dest);

    if (summary && !('skipped' in summary)) obj.summary = summary;

    return obj;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Write an export file, or skip when the selection is empty. */
export async function exportToFile(
  /** Transfer hooks, timeouts, and cancellation. */
  ctx: TransferContext,
  /** Workspace whose chats are exported. */
  workspace: WorkspaceEntry,
  /** Destination archive path. */
  destPath: string,
  /** Chat ids to export. Omit to export every listed chat. */
  selectedIds?: string[],
  /** When true, count recoverable chats and skip compression when none exist. */
  assessRecovery = false,
): Promise<
  | {
      /** True when the user cancelled or there was nothing to write. */
      skipped: true;
      /** Why no file was written. */
      reason: string;
    }
  | NonNullable<ExportObject['summary']>
> {
  if (selectedIds && selectedIds.length === 0) {
    return { skipped: true, reason: 'empty-selection' };
  }

  const global = await openReadTransaction(
    connOf(ctx, workspace.globalDbPath, true),
  );

  let local: Awaited<ReturnType<typeof openReadTransaction>> | undefined;

  try {
    local = await openReadTransaction(
      connOf(ctx, workspace.workspaceDbPath, true),
    );

    const listed = await listWorkspaceChats(ctx, workspace, {
      connections: { connGl: global.conn, connWs: local.conn },
    });

    await local.close();
    const selected = selectChats(listed.allComposers, selectedIds);

    ctx.onPhase?.('selection', { chats: selected.length });

    return await exportBundle({
      ctx,
      workspace,
      conn: global.conn,
      destPath,
      selected,
      source: listed.source,
      readComplete: global.close,
      assessRecovery,
    });
  } finally {
    try {
      await local?.close();
    } finally {
      await global.close();
    }
  }
}
