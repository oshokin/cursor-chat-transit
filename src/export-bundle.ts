import { readSessionKv } from './kv-session';
import { inChat, transferEvent, traceIO } from './transfer-events';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  attachmentDirectory,
  collectAttachmentVariants,
  decodeAttachment,
  imageBasenamesFromBubbles,
} from './attachments';
import { MAX_SQLITE_VALUE_BYTES } from './bundle-limits';
import { BundleWriter } from './bundle-writer';
import {
  canvasFilenamesFromChat,
  decodeCanvas,
  readCanvasFile,
} from './canvases';
import { bubbleRange, sqlText } from './core';
import {
  blobKeysFromComposerBody,
  imageUuidsFromBubbles,
  readBlobGraph,
} from './dependencies';
import * as db from './db';
import { splitConversation } from './import-policy';
import { decodePlan, planFilenamesFromChat, readPlanFile } from './plans';
import { parseBoundedJson } from './record-json';
import { execSql } from './sqlite';
import {
  canvasesDirOf,
  chatIssue,
  chatLogLabel,
  plansDirOf,
} from './transfer-context';
import type {
  ComposerHeader,
  ExportChatIssue,
  ExportObject,
  SqliteConn,
  TransferContext,
  WorkspaceEntry,
} from './types';
import { TransferError } from './types';

/** Stream the selected chats into one v4 archive. */
export async function exportBundle(opts: {
  /** Transfer context. */
  ctx: TransferContext;
  /** Source workspace. */
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
    };

    await opts.readComplete();
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

/** Export one composer: body, bubbles, and the blob closure. */
export async function readChatForExport(opts: {
  /** Transfer hooks, timeouts, and cancellation. */
  ctx: TransferContext;
  /** Workspace whose global database is being read. */
  workspace: WorkspaceEntry;
  /** Read-only connection to the export snapshot. */
  conn: SqliteConn;
  /** Composer header for this chat. */
  header: ComposerHeader;
  /** Archive writer receiving this chat. */
  writer: Pick<
    BundleWriter,
    | 'beginChat'
    | 'writeComposer'
    | 'writeConversation'
    | 'writeBubble'
    | 'writeResource'
    | 'addBlob'
    | 'endChat'
  >;
  /** Directory for spilled resources; omitted by read-only inspection. */
  tmp?: string;
  /** Incomplete-chat reasons collected for the summary. */
  issues: ExportChatIssue[];
  /** Composer ids that were not fully exported. */
  incomplete: string[];
  /** Called once per bubble so the caller can report progress. */
  onBubble: () => void;
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

  await opts.writer.beginChat(opts.header as Record<string, unknown>);
  await opts.writer.writeComposer(split.fields, layout);

  for (const item of split.items) await opts.writer.writeConversation(item);

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

    await opts.writer.writeBubble(bubble.bubbleId, payload);

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

  await writeResources({ ...opts, body, refs });
  await opts.writer.endChat();

  return true;
}

/** Write kv blobs from the closure, then images, plans, and canvases. */
async function writeResources(opts: {
  /** Transfer hooks, timeouts, and cancellation. */
  ctx: TransferContext;
  /** Workspace that owns plans and canvases on disk. */
  workspace: WorkspaceEntry;
  /** Read-only connection to the export snapshot. */
  conn: SqliteConn;
  /** Composer header for this chat. */
  header: ComposerHeader;
  /** Archive writer receiving resource pointers. */
  writer: Pick<
    BundleWriter,
    | 'beginChat'
    | 'writeComposer'
    | 'writeConversation'
    | 'writeBubble'
    | 'writeResource'
    | 'addBlob'
    | 'endChat'
  >;
  /** Directory for spilled resources; omitted by read-only inspection. */
  tmp?: string;
  /** Incomplete-chat reasons collected for the summary. */
  issues: ExportChatIssue[];
  /** Composer JSON used to discover blob dependencies. */
  body: string;
  /** Image, plan, and canvas names already found on this chat. */
  refs: {
    /** Image uuid to the basenames that referenced it. */
    images: Map<string, Set<string>>;
    /** Plan basenames referenced by this chat. */
    plans: Set<string>;
    /** Canvas basenames referenced by this chat. */
    canvases: Set<string>;
  };
}): Promise<void> {
  const blobs = blobKeysFromComposerBody(opts.body);

  if (blobs.status === 'unsupported') {
    const err = new TransferError(
      'This chat uses an unsupported conversation state format.',
    );

    err.code = 'UNSUPPORTED_STATE';

    throw err;
  }

  const parsed = JSON.parse(opts.body) as { conversationState?: unknown };
  const written = new Set<string>();
  const session = opts.conn.session;

  if (!session) throw new Error('Export requires an owned read transaction.');
  let lastProgress = 0;

  opts.ctx.onPhase?.('collect', {
    processed: 0,
    unit: 'resources',
    chatName: opts.header.name,
  });

  const closed = await readBlobGraph(
    parsed.conversationState,
    async (digests) => {
      const batch = new Map<string, Buffer | null>();

      for (const digest of digests) {
        opts.ctx.signal?.throwIfAborted();
        const key = `agentKv:blob:${digest}`;

        const row = await traceIO(
          'Read chat dependency',
          { path: opts.conn.database, key },
          () => readSessionKv(session, key),
        );

        batch.set(digest, row?.bytes ?? null);
        if (!row || written.has(key)) continue;
        const sha = await writeTempBytes(opts.tmp, row.bytes);

        if (sha.file) await opts.writer.addBlob(sha.sha256, sha.file);

        await opts.writer.writeResource({
          class: 'kv',
          id: key,
          sha256: sha.sha256,
          byteLength: row.bytes.length,
          storageClass: row.storageClass,
        });

        if (sha.file) await rm(sha.file, { force: true });
        written.add(key);

        if (performance.now() - lastProgress >= 250) {
          lastProgress = performance.now();

          opts.ctx.onPhase?.('collect', {
            processed: written.size,
            unit: 'resources',
            chatName: opts.header.name,
          });
        }
      }

      return batch;
    },
  );

  if (closed.status !== 'ok') {
    const err = new TransferError(
      'This chat uses an unsupported conversation state format.',
    );

    err.code = 'UNSUPPORTED_STATE';

    throw err;
  }

  const missingBlobs = closed.missing.length;

  let missingImages = 0;

  try {
    for (const [uuid, aliases] of opts.refs.images) {
      opts.ctx.signal?.throwIfAborted();
      await rejectImageSymlinks(opts.workspace, uuid);
      const names = [...aliases];

      const found = await collectAttachmentVariants(
        opts.workspace,
        uuid,
        names,
      );

      if (found.missing || !found.resources.length) {
        missingImages += 1;
        continue;
      }

      for (const resource of found.resources) {
        opts.ctx.signal?.throwIfAborted();
        const sha = await writeTempBytes(opts.tmp, decodeAttachment(resource));

        if (sha.file) await opts.writer.addBlob(resource.sha256, sha.file);

        await opts.writer.writeResource({
          class: 'image',
          id: resource.id,
          sha256: resource.sha256,
          byteLength: resource.byteLength,
          filename: resource.filename,
          extension: resource.extension,
          aliases: resource.aliases,
        });

        if (sha.file) await rm(sha.file, { force: true });
      }
    }
  } catch (err) {
    if (err instanceof TransferError) throw err;
    opts.issues.push(chatIssue(opts.header, 'invalid-attachment-id'));

    return;
  }

  let missingPlans = 0;

  for (const name of opts.refs.plans) {
    opts.ctx.signal?.throwIfAborted();
    const resource = await readPlanFile(plansDirOf(opts.ctx), name);

    if (!resource) {
      missingPlans += 1;
      continue;
    }

    const sha = await writeTempBytes(opts.tmp, decodePlan(resource));

    if (sha.file) await opts.writer.addBlob(resource.sha256, sha.file);

    await opts.writer.writeResource({
      class: 'plan',
      id: name,
      filename: name,
      sha256: resource.sha256,
      byteLength: resource.byteLength,
    });

    if (sha.file) await rm(sha.file, { force: true });
  }

  const canvasesDir = canvasesDirOf(opts.ctx, opts.workspace);
  let missingCanvases = canvasesDir ? 0 : opts.refs.canvases.size;

  if (canvasesDir) {
    for (const name of opts.refs.canvases) {
      opts.ctx.signal?.throwIfAborted();
      const resource = await readCanvasFile(canvasesDir, name);

      if (!resource) {
        missingCanvases += 1;
        continue;
      }

      const sha = await writeTempBytes(opts.tmp, decodeCanvas(resource));

      if (sha.file) await opts.writer.addBlob(resource.sha256, sha.file);

      await opts.writer.writeResource({
        class: 'canvas',
        id: name,
        filename: name,
        sha256: resource.sha256,
        byteLength: resource.byteLength,
      });

      if (sha.file) await rm(sha.file, { force: true });
    }
  }

  if (missingBlobs || missingImages || missingPlans || missingCanvases) {
    opts.issues.push(
      chatIssue(opts.header, 'missing-dependencies', {
        missingBlobs,
        missingImages,
        missingPlans,
        missingCanvases,
      }),
    );

    opts.ctx.onNote?.(
      `Incomplete chat ${chatLogLabel(opts.header)} missingBlobs=${missingBlobs} missingImages=${missingImages} missingPlans=${missingPlans} missingCanvases=${missingCanvases}`,
    );
  }
}

/** Refuse an attachment name that is a symlink for this image uuid. */
async function rejectImageSymlinks(
  workspace: WorkspaceEntry,
  uuid: string,
): Promise<void> {
  const dir = attachmentDirectory(workspace);
  let names: string[];

  try {
    names = await readdir(dir);
  } catch {
    return;
  }

  for (const name of names) {
    if (!name.includes(uuid)) continue;
    const st = await lstat(path.join(dir, name));

    if (st.isSymbolicLink()) {
      const err = new TransferError(
        'Attachment path escapes workspace storage.',
      );

      err.code = 'INVALID_RESOURCE';

      throw err;
    }
  }
}

/** Byte length of a cursorDiskKV value, or -1 when the key is absent. */
async function valueBytes(conn: SqliteConn, key: string): Promise<number> {
  const out = await execSql({
    ...conn,
    sql: `SELECT coalesce(length(CAST(value AS BLOB)), -1) FROM cursorDiskKV WHERE key = ${sqlText(key)};`,
    readOnly: true,
  });

  const text = out.trim();

  if (!text) return -1;

  return Number(text);
}

/** Spill bytes to a content-addressed temp file. */
async function writeTempBytes(
  dir: string | undefined,
  bytes: Buffer,
): Promise<{ file: string; sha256: string }> {
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  // A read-only inspection validates resources without spilling or packaging them.
  if (!dir) return { file: '', sha256 };
  const file = path.join(dir, sha256);

  await writeFile(file, bytes, { flag: 'wx' }).catch(
    (err: NodeJS.ErrnoException) => {
      if (err.code !== 'EEXIST') throw err;
    },
  );

  return { file, sha256 };
}
