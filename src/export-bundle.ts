import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BundleWriter } from './bundle-writer';
import { bubbleRange, sqlText } from './core';
import { readChatForExport } from './export-chat';
import { execSql } from './sqlite';
import { inChat, transferEvent } from './transfer-events';
import type {
  ComposerHeader,
  ExportChatIssue,
  ExportObject,
  SqliteConn,
  TransferContext,
  WorkspaceEntry,
} from './types';

/** Stream the selected chats into one v4 archive. */
export async function exportBundle(opts: {
  /** Transfer context. */
  ctx: TransferContext;
  workspace: WorkspaceEntry;
  /** Open read-only global database. */
  conn: SqliteConn;
  /** Destination ZIP path. */
  destPath: string;
  /** Headers to export, in catalogue order. */
  selected: ComposerHeader[];
  /** Provenance stored in the manifest. */
  source: unknown;
  /** Release source database locks before inventory hashing and ZIP compression. */
  readComplete: () => Promise<void>;
  /** Assess recovery during the same read, with no second source scan. */
  assessRecovery?: boolean;
}): Promise<NonNullable<ExportObject['summary']>> {
  const writer = await BundleWriter.open(opts.destPath, {
    signal: opts.ctx.signal,
    source: opts.source,
  });

  const issues: ExportChatIssue[] = [];
  const incomplete: string[] = [];
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'cct-export-'));
  let bubbles = 0;
  let exported = 0;
  let recoveryCandidates = 0;

  try {
    let processed = 0;

    for (const header of opts.selected) {
      opts.ctx.signal?.throwIfAborted();
      processed += 1;

      const range = bubbleRange(header.composerId);

      const messageTotal = Number(
        (
          await execSql({
            ...opts.conn,
            sql: `SELECT count(*) FROM cursorDiskKV WHERE key >= ${sqlText(range.lower)} AND key < ${sqlText(range.upper)};`,
            readOnly: true,
          })
        ).trim(),
      );

      let chatBubbles = 0;

      opts.ctx.onPhase?.('read', {
        chatName: header.name,
        chatIndex: processed,
        chatTotal: opts.selected.length,
        processed: 0,
        total: messageTotal,
        unit: 'messages',
      });

      transferEvent({
        action: 'Export chat',
        status: 'started',
        path: opts.conn.database,
        chatId: header.composerId,
        chatName: header.name,
      });

      const wrote = await inChat(
        header.composerId,
        header.name || header.composerId,
        () =>
          readChatForExport({
            ctx: opts.ctx,
            workspace: opts.workspace,
            conn: opts.conn,
            header,
            writer,
            tmp,
            issues,
            incomplete,
            onRecoveryCandidate: opts.assessRecovery
              ? (
                  /** Whether this chat is a recovery candidate. */
                  candidate,
                ) => {
                  if (candidate) recoveryCandidates++;
                }
              : undefined,
            onBubble: () => {
              bubbles += 1;
              chatBubbles += 1;
              if (chatBubbles % 100 === 0 || chatBubbles === messageTotal)
                opts.ctx.onPhase?.('read', {
                  chatName: header.name,
                  chatIndex: processed,
                  chatTotal: opts.selected.length,
                  processed: chatBubbles,
                  total: messageTotal,
                  unit: 'messages',
                });
            },
          }),
      );

      if (wrote) exported += 1;
    }

    const summary: NonNullable<ExportObject['summary']> = {
      complete: incomplete.length === 0 && issues.length === 0,
      incomplete,
      selected: opts.selected.length,
      exported,
      issues,
      ...(opts.assessRecovery ? { recoveryCandidates } : {}),
    };

    await opts.readComplete();

    if (opts.assessRecovery && recoveryCandidates === 0) {
      opts.ctx.onNote?.(
        'No recovery candidates; discard staging without compressing an archive',
      );

      await writer.abort();

      return summary;
    }

    opts.ctx.onPhase?.('write', { chats: exported, bubbles });
    await writer.finish(summary);

    return summary;
  } catch (err) {
    await writer.abort();

    throw err;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
