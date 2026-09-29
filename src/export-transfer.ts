import { selectChats } from './core';
import * as db from './db';
import {
  blobKeysFromComposerBody,
  collectExportResources,
  imageUuidsFromBubbles,
} from './dependencies';
import { EXPORT_FORMAT_VERSION, ExportFileWriter } from './format';
import { planFilenamesFromChat } from './plans';
import {
  chatIssue,
  chatLogLabel,
  inspectPair,
  plansDirOf,
  withGlobalSnapshot,
} from './transfer-context';
import type {
  BubbleRecord,
  ComposerHeader,
  ExportChatIssue,
  ExportObject,
  SqliteConn,
  TransferContext,
  WorkspaceEntry,
} from './types';
import { TransferError } from './types';

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
  const listed = await listWorkspaceChats(ctx, workspace);
  const selected = selectChats(listed.allComposers, selectedIds);
  return withGlobalSnapshot(ctx, workspace, async (connGl) => {
    const { snapshot, composers, bubbles, incomplete } =
      await readSelectedChats(connGl, selected);
    const allComposers = snapshot.map((row) => row.header);
    const collected = await collectExportResources({
      conn: connGl,
      composers,
      bubbles,
      workspace,
      signal: ctx.signal,
      plansDir: plansDirOf(ctx),
    });
    if (collected.assessment.status === 'unsupported') {
      const err = new TransferError(
        'This chat uses an unsupported conversation state format.',
      );
      err.code = 'UNSUPPORTED_STATE';
      throw err;
    }
    return {
      formatVersion: EXPORT_FORMAT_VERSION,
      source: listed.source,
      allComposers,
      composers,
      bubbles,
      resources: collected.resources,
      summary: {
        complete:
          incomplete.length === 0 && collected.assessment.status === 'complete',
        incomplete,
        selected: selected.length,
        exported: allComposers.length,
        dependencies: collected.assessment,
      },
    };
  });
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
  return withGlobalSnapshot(ctx, workspace, async (connGl) => {
    const issues: ExportChatIssue[] = [];
    const {
      snapshot,
      composers,
      bubbles: bubblesByComposer,
      incomplete,
    } = await readSelectedChats(
      connGl,
      selected,
      ({ header, body, processed, loaded }) => {
        ctx.onPhase?.('read', {
          chats: loaded,
          processed,
          total: selected.length,
        });
        if (body === null) {
          issues.push(chatIssue(header, 'missing-body'));
          ctx.onNote?.(
            `unreadable chat ${chatLogLabel(header)} reason=missing-body`,
          );
        }
      },
    );
    ctx.onPhase?.('collect', { chats: snapshot.length });
    const collected = await collectExportResources({
      conn: connGl,
      composers,
      bubbles: bubblesByComposer,
      workspace,
      signal: ctx.signal,
      plansDir: plansDirOf(ctx),
      onProgress: (processed, total) =>
        ctx.onPhase?.('collect', { chats: snapshot.length, processed, total }),
    });
    if (collected.assessment.status === 'unsupported') {
      const err = new TransferError(
        'This chat uses an unsupported conversation state format.',
      );
      err.code = 'UNSUPPORTED_STATE';
      throw err;
    }
    const foundKeys = new Set(collected.resources.kv.map((row) => row.key));
    const foundImages = new Set(
      collected.resources.attachments.map((row) => row.id.toLowerCase()),
    );
    const foundPlans = new Set(
      collected.resources.plans.map((row) => row.filename),
    );
    for (const row of snapshot) {
      const blobs = blobKeysFromComposerBody(row.body);
      if (blobs.status === 'unsupported') {
        issues.push(chatIssue(row.header, 'unsupported-state'));
        ctx.onNote?.(
          `unreadable chat ${chatLogLabel(row.header)} reason=unsupported-state`,
        );
        continue;
      }
      let missingBlobs = 0;
      for (const key of blobs.keys) {
        if (!foundKeys.has(key)) missingBlobs += 1;
      }
      let missingImages = 0;
      try {
        for (const uuid of imageUuidsFromBubbles(
          bubblesByComposer[row.header.composerId],
        )) {
          if (!foundImages.has(uuid.toLowerCase())) missingImages += 1;
        }
      } catch {
        issues.push(chatIssue(row.header, 'invalid-attachment-id'));
        ctx.onNote?.(
          `unreadable chat ${chatLogLabel(row.header)} reason=invalid-attachment-id`,
        );
        continue;
      }
      let missingPlans = 0;
      for (const name of planFilenamesFromChat(
        row.body,
        bubblesByComposer[row.header.composerId],
      )) {
        if (!foundPlans.has(name)) missingPlans += 1;
      }
      if (missingBlobs || missingImages || missingPlans) {
        issues.push(
          chatIssue(row.header, 'missing-dependencies', {
            missingBlobs,
            missingImages,
            missingPlans,
          }),
        );
        ctx.onNote?.(
          `incomplete chat ${chatLogLabel(row.header)} missingBlobs=${missingBlobs} missingImages=${missingImages} missingPlans=${missingPlans}`,
        );
      }
    }
    const writer = await ExportFileWriter.open(destPath, ctx.signal);
    let bubbles = 0;
    try {
      await writer.writePreamble({
        formatVersion: EXPORT_FORMAT_VERSION,
        source: listed.source,
        allComposers: snapshot.map((row) => row.header),
      });
      for (const row of snapshot) {
        await writer.writeComposer(row.header.composerId, row.body);
      }
      await writer.beginBubbles();
      for (const row of snapshot) {
        await writer.beginBubbleGroup(row.header.composerId);
        for (const bubble of bubblesByComposer[row.header.composerId] || []) {
          await writer.writeBubble(bubble);
          bubbles += 1;
        }
        await writer.endBubbleGroup();
      }
      const summary = {
        complete:
          incomplete.length === 0 && collected.assessment.status === 'complete',
        incomplete,
        selected: selected.length,
        exported: snapshot.length,
        dependencies: collected.assessment,
        issues,
      };
      ctx.onPhase?.('write', {
        chats: snapshot.length,
        bubbles,
        resources: collected.resources.kv.length,
        missing:
          collected.assessment.missingKeys.length +
          collected.assessment.missingAttachments.length +
          collected.assessment.missingPlans.length,
      });
      await writer.finish(summary, collected.resources);
      return summary;
    } catch (err) {
      await writer.abort();
      throw err;
    }
  });
}

/** Shared snapshot reader for object and file exports; notification policy stays with the caller. */
async function readSelectedChats(
  conn: SqliteConn,
  selected: ComposerHeader[],
  onRead?: (entry: {
    header: ComposerHeader;
    body: string | null;
    processed: number;
    loaded: number;
  }) => void,
) {
  const snapshot: Array<{ header: ComposerHeader; body: string }> = [];
  const composers: Record<string, string> = {};
  const bubbles: Record<string, BubbleRecord[]> = {};
  const incomplete: string[] = [];
  let processed = 0;
  for (const header of selected) {
    const body = await db.readKvText(conn, `composerData:${header.composerId}`);
    onRead?.({ header, body, processed: ++processed, loaded: snapshot.length });
    if (body === null) {
      incomplete.push(header.composerId);
      continue;
    }
    snapshot.push({ header, body });
    composers[header.composerId] = body;
    bubbles[header.composerId] = await db.readBubbles(conn, header.composerId);
  }
  return { snapshot, composers, bubbles, incomplete };
}
