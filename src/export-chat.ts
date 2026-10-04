import { imageBasenamesFromBubbles } from './attachments';
import { MAX_SQLITE_VALUE_BYTES } from './bundle-limits';
import type { ExportChatWriter } from './bundle-writer';
import { canvasFilenamesFromChat } from './canvases';
import { sqlText } from './core';
import * as db from './db';
import { imageUuidsFromBubbles } from './dependencies';
import { writeResources } from './export-resources';
import { splitConversation } from './import-policy';
import { planFilenamesFromChat } from './plans';
import { parseBoundedJson } from './record-json';
import { RecoverySourceCheck } from './recovery-source';
import { execSql } from './sqlite';
import { recoverMissingMessage } from './text-recovery';
import { chatIssue, chatLogLabel } from './transfer-context';
import type {
  ComposerHeader,
  ExportChatIssue,
  SqliteConn,
  TransferContext,
  WorkspaceEntry,
} from './types';
import { TransferError } from './types';

/** Export one composer: body, bubbles, and the blob closure. */
export async function readChatForExport(opts: {
  /** Transfer hooks, timeouts, and cancellation. */
  ctx: TransferContext;
  /** Workspace whose global database is being read. */
  workspace: WorkspaceEntry;
  /** Read-only connection to the export snapshot. */
  conn: SqliteConn;
  header: ComposerHeader;
  /** Archive writer receiving this chat. */
  writer: ExportChatWriter;
  /** Directory for spilled resources; omitted by read-only inspection. */
  tmp?: string;
  /** Incomplete-chat reasons collected for the summary. */
  issues: ExportChatIssue[];
  /** Composer ids that were not fully exported. */
  incomplete: string[];
  /** Called once per bubble so the caller can report progress. */
  onBubble: () => void;
  /** Report source viability without retaining message bodies or reading twice. */
  onRecoveryCandidate?: (
    /** Whether this chat is a recovery candidate. */
    candidate: boolean,
  ) => void;
}): Promise<boolean> {
  const id = opts.header.composerId;
  const bytes = await valueBytes(opts.conn, `composerData:${id}`);

  if (bytes < 0) {
    opts.incomplete.push(id);
    opts.issues.push(chatIssue(opts.header, 'missing-body'));

    opts.ctx.onNote?.(
      `Unreadable chat ${chatLogLabel(opts.header)} reason=missing-body`,
    );

    return false;
  }

  if (bytes > MAX_SQLITE_VALUE_BYTES) {
    throw new TransferError(
      `Chat ${id} composer row is ${bytes} bytes; the supported limit is ${MAX_SQLITE_VALUE_BYTES}.`,
    );
  }

  const body = await db.readKvText(opts.conn, `composerData:${id}`);

  if (body === null) {
    opts.incomplete.push(id);
    opts.issues.push(chatIssue(opts.header, 'missing-body'));

    return false;
  }

  const parsed = parseBoundedJson(Buffer.from(body, 'utf8'), `composer ${id}`);

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TransferError(`Chat ${id} composer row is not a JSON object.`);
  }

  const split = splitConversation(parsed as Record<string, unknown>);
  const layout = split.state === 'present' ? 'ndjson' : split.state;

  const recovery = opts.onRecoveryCandidate
    ? new RecoverySourceCheck(
        id,
        split.fields,
        split.items,
        split.state === 'present',
      )
    : undefined;

  const issueStart = opts.issues.length;

  await opts.writer.beginChat(opts.header as Record<string, unknown>);
  await opts.writer.writeComposer(split.fields, layout);

  const remaining = new Set<string>();

  for (const item of split.items) {
    await opts.writer.writeConversation(item);
    if (
      item &&
      typeof item === 'object' &&
      'bubbleId' in item &&
      typeof item.bubbleId === 'string'
    )
      remaining.add(item.bubbleId);
  }

  let readableText = false;

  const refs = {
    images: new Map<string, Set<string>>(),
    plans: new Set(planFilenamesFromChat(body, [])),
    canvases: new Set(canvasFilenamesFromChat(body, [])),
  };

  await db.forEachBubble(opts.conn, id, async (bubble) => {
    if (Buffer.byteLength(bubble.value, 'utf8') > MAX_SQLITE_VALUE_BYTES) {
      throw new TransferError(
        `Chat ${id} message ${bubble.bubbleId} exceeds ${MAX_SQLITE_VALUE_BYTES} bytes.`,
      );
    }

    const payload = parseBoundedJson(
      Buffer.from(bubble.value, 'utf8'),
      `bubble ${bubble.bubbleId}`,
    );

    if (
      payload &&
      typeof payload === 'object' &&
      !Array.isArray(payload) &&
      typeof (payload as Record<string, unknown>).text === 'string' &&
      String((payload as Record<string, unknown>).text).trim()
    )
      readableText = true;
    recovery?.bubble(bubble.bubbleId, payload);
    await opts.writer.writeBubble(bubble.bubbleId, payload);
    remaining.delete(bubble.bubbleId);

    for (const uuid of imageUuidsFromBubbles([bubble])) {
      const names = refs.images.get(uuid) || new Set<string>();

      for (const name of imageBasenamesFromBubbles([bubble], uuid))
        names.add(name);
      refs.images.set(uuid, names);
    }

    for (const name of planFilenamesFromChat('{}', [bubble]))
      refs.plans.add(name);
    for (const name of canvasFilenamesFromChat('{}', [bubble]))
      refs.canvases.add(name);
    opts.onBubble();
  });

  let previews = 0;
  let gaps = 0;

  const hasPreview =
    opts.ctx.recoverText &&
    remaining.size > 0 &&
    split.items.some(
      (item) =>
        item &&
        typeof item === 'object' &&
        !Array.isArray(item) &&
        remaining.has(String((item as Record<string, unknown>).bubbleId)) &&
        recoverMissingMessage(id, item as Record<string, unknown>)?.preview,
    );

  if (opts.ctx.recoverText && (readableText || hasPreview)) {
    for (const item of split.items) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const header = item as Record<string, unknown>;

      if (
        typeof header.bubbleId !== 'string' ||
        !remaining.has(header.bubbleId)
      )
        continue;
      const recovered = recoverMissingMessage(id, header);

      if (!recovered) continue;
      await opts.writer.writeBubble(header.bubbleId, recovered.payload);
      remaining.delete(header.bubbleId);
      if (recovered.preview) previews++;
      else gaps++;
    }

    if (previews || gaps) {
      split.fields.cctTextRecovery = { version: 1, previews, gaps };
      await opts.writer.writeComposer(split.fields, layout);
      opts.incomplete.push(id);

      opts.issues.push(
        chatIssue(opts.header, 'recovered-text', {
          missingMessages: previews + gaps,
        }),
      );

      opts.ctx.onNote?.(
        `Recovered available history ${chatLogLabel(opts.header)} previews=${previews} gaps=${gaps}`,
      );
    }
  }

  if (remaining.size) {
    opts.incomplete.push(id);

    opts.issues.push(
      chatIssue(opts.header, 'missing-messages', {
        missingMessages: remaining.size,
      }),
    );

    opts.ctx.onNote?.(
      `Incomplete chat ${chatLogLabel(opts.header)}: ${remaining.size} referenced message bodies are missing; first missing message=${remaining.values().next().value}`,
    );
  }

  await writeResources({ ...opts, body, refs });
  await opts.writer.endChat();

  if (recovery) {
    const candidate =
      recovery.candidate &&
      opts.issues
        .slice(issueStart)
        .every(
          (/** Export or health problem. */ issue) =>
            issue.reason === 'missing-dependencies',
        );

    opts.onRecoveryCandidate?.(candidate);

    opts.ctx.onNote?.(
      `Recovery source checked ${chatLogLabel(opts.header)}: ${candidate ? 'Message bodies available; destination checks required' : 'No supported recovery candidate; source data kept'}`,
    );
  }

  return true;
}

/** Byte length of a cursorDiskKV value, or -1 when the key is absent. */
async function valueBytes(
  /** Open global or workspace database. */
  conn: SqliteConn,
  /** cursorDiskKV key. */
  key: string,
): Promise<number> {
  const out = await execSql({
    ...conn,
    sql: `SELECT coalesce(length(CAST(value AS BLOB)), -1) FROM cursorDiskKV WHERE key = ${sqlText(key)};`,
    readOnly: true,
  });

  const text = out.trim();

  if (!text) return -1;

  return Number(text);
}
