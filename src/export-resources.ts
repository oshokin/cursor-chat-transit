import { createHash } from 'node:crypto';
import { lstat, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  attachmentDirectory,
  collectAttachmentVariants,
  decodeAttachment,
} from './attachments';
import type { ExportChatWriter } from './bundle-writer';
import { decodeCanvas, readCanvasFile } from './canvases';
import { blobKeysFromComposerBody, readBlobGraph } from './dependencies';
import { readSessionKvBatch } from './kv-session';
import { decodePlan, readPlanFile } from './plans';
import {
  canvasesDirOf,
  chatIssue,
  chatLogLabel,
  plansDirOf,
} from './transfer-context';
import { traceIO } from './transfer-events';
import type {
  ComposerHeader,
  ExportChatIssue,
  SqliteConn,
  TransferContext,
  WorkspaceEntry,
} from './types';
import { TransferError } from './types';

/** Write kv blobs from the closure, then images, plans, and canvases. */
export async function writeResources(opts: {
  /** Transfer hooks, timeouts, and cancellation. */
  ctx: TransferContext;
  /** Workspace that owns plans and canvases on disk. */
  workspace: WorkspaceEntry;
  /** Read-only connection to the export snapshot. */
  conn: SqliteConn;
  header: ComposerHeader;
  /** Archive writer receiving resource pointers. */
  writer: ExportChatWriter;
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

  const parsed = JSON.parse(opts.body) as {
    /** Composer conversation pointer, when present. */
    conversationState?: unknown;
  };

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
    async (/** Blob digests for this call. */ digests) => {
      const batch = new Map<string, Buffer | null>();

      opts.ctx.signal?.throwIfAborted();

      const keys = digests.map(
        (/** Blob digest. */ digest) => `agentKv:blob:${digest}`,
      );

      const rows = await traceIO(
        'Read chat dependency batch',
        { path: opts.conn.database, key: keys.join(', ') },
        () => readSessionKvBatch(session, keys),
      );

      for (const [key, row] of rows) {
        opts.ctx.signal?.throwIfAborted();
        batch.set(key.slice('agentKv:blob:'.length), row?.bytes ?? null);
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
    32,
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
  /** Workspace that owns the image directory. */
  workspace: WorkspaceEntry,
  /** Composer id used as the image directory name. */
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

/** Spill bytes to a content-addressed temp file. */
async function writeTempBytes(
  /** Directory that receives the spill file. Absent skips the write. */
  dir: string | undefined,
  /** Bytes to hash and, when large, spill. */
  bytes: Buffer,
): Promise<{
  /** Spill path, empty when the bytes stayed in memory. */
  file: string;
  /** SHA-256 of `bytes`. */
  sha256: string;
}> {
  // A read-only inspection validates resources without spilling or packaging them.
  if (!dir) return { file: '', sha256: '' };
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const file = path.join(dir, sha256);

  await writeFile(file, bytes, { flag: 'wx' }).catch(
    (err: NodeJS.ErrnoException) => {
      if (err.code !== 'EEXIST') throw err;
    },
  );

  return { file, sha256 };
}
