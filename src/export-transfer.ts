import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readBundleObject } from './bundle-object';
import { selectChats } from './core';
import * as db from './db';
import { exportBundle } from './export-bundle';
import { inspectPair, withGlobalSnapshot } from './transfer-context';
import type {
  ComposerHeader,
  ExportObject,
  TransferContext,
  WorkspaceEntry,
} from './types';

/** List composer headers for a workspace without loading bubble bodies. */
export async function listWorkspaceChats(
  ctx: TransferContext,
  workspace: WorkspaceEntry,
  options: {
    /** When true, merge timestamp columns from composerHeaders into listed headers. */
    includeColumnDates?: boolean;
  } = {},
): Promise<{
  /** Merged composer headers visible in this workspace. */
  allComposers: ComposerHeader[];
  /** Provenance recorded for a later export. */
  source: NonNullable<ExportObject['source']>;
}> {
  const { connWs, connGl, wsInfo, glInfo } = await inspectPair(ctx, workspace);

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
  ctx: TransferContext,
  workspace: WorkspaceEntry,
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
  ctx: TransferContext,
  workspace: WorkspaceEntry,
  destPath: string,
  selectedIds?: string[],
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

  const listed = await listWorkspaceChats(ctx, workspace);

  ctx.onPhase?.('selection', { chats: listed.allComposers.length });
  const selected = selectChats(listed.allComposers, selectedIds);

  return withGlobalSnapshot(ctx, workspace, (connGl) =>
    exportBundle({
      ctx,
      workspace,
      conn: connGl,
      destPath,
      selected,
      source: listed.source,
    }),
  );
}
