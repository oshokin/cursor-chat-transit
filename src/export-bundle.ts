import { rm } from 'node:fs/promises';
import { operationTempDir } from './operation-temp';
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

/** Aggregate counters shared by one or many workspace export scopes. */
export interface ExportAccumulator {
  issues: ExportChatIssue[];
  incomplete: string[];
  bubbles: number;
  exported: number;
  recoveryCandidates: number;
}

/** Stream selected chats into an already open bundle writer. */
export async function writeSelectedChats(opts: {
  ctx: TransferContext;
  workspace: WorkspaceEntry;
  conn: SqliteConn;
  selected: ComposerHeader[];
  writer: BundleWriter;
  tmp: string;
  accumulator: ExportAccumulator;
  assessRecovery?: boolean;
  /** Number of chats completed before this workspace. */
  chatOffset?: number;
  /** Total chats across every workspace scope. */
  chatTotal?: number;
}): Promise<void> {
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
    const chatIndex = (opts.chatOffset || 0) + processed;
    const chatTotal = opts.chatTotal || opts.selected.length;

    opts.ctx.onPhase?.('read', {
      chatName: header.name,
      chatIndex,
      chatTotal,
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
          writer: opts.writer,
          tmp: opts.tmp,
          issues: opts.accumulator.issues,
          incomplete: opts.accumulator.incomplete,
          onRecoveryCandidate: opts.assessRecovery
            ? (candidate) => {
                if (candidate) opts.accumulator.recoveryCandidates++;
              }
            : undefined,
          onBubble: () => {
            opts.accumulator.bubbles += 1;
            chatBubbles += 1;
            if (chatBubbles % 100 === 0 || chatBubbles === messageTotal)
              opts.ctx.onPhase?.('read', {
                chatName: header.name,
                chatIndex,
                chatTotal,
                processed: chatBubbles,
                total: messageTotal,
                unit: 'messages',
              });
          },
        }),
    );

    if (wrote) opts.accumulator.exported += 1;
  }
}

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
    maxJsonProperties: opts.ctx.maxJsonProperties,
  });

  const tmp = await operationTempDir(
    'cct-export-',
    opts.ctx.temporaryDirectory,
  );

  const accumulator: ExportAccumulator = {
    issues: [],
    incomplete: [],
    bubbles: 0,
    exported: 0,
    recoveryCandidates: 0,
  };

  try {
    await writeSelectedChats({
      ...opts,
      writer,
      tmp,
      accumulator,
    });

    const summary: NonNullable<ExportObject['summary']> = {
      complete:
        accumulator.incomplete.length === 0 && accumulator.issues.length === 0,
      incomplete: accumulator.incomplete,
      selected: opts.selected.length,
      exported: accumulator.exported,
      issues: accumulator.issues,
      ...(opts.assessRecovery
        ? { recoveryCandidates: accumulator.recoveryCandidates }
        : {}),
    };

    await opts.readComplete();

    if (opts.assessRecovery && accumulator.recoveryCandidates === 0) {
      opts.ctx.onNote?.(
        'No recovery candidates; discard staging without compressing an archive',
      );

      await writer.abort();

      return summary;
    }

    opts.ctx.onPhase?.('write', {
      chats: accumulator.exported,
      bubbles: accumulator.bubbles,
    });

    await writer.finish(summary);

    return summary;
  } catch (err) {
    await writer.abort();

    throw err;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
