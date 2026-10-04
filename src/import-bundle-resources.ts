import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { attachmentDirectory, resolveAttachmentPath } from './attachments';
import { canvasFilePath, readCanvasFile } from './canvases';
import { sqlText } from './core';
import * as db from './db';
import { hashFile } from './hash-file';
import { ChatRow, json } from './import-bundle-common';
import { JournalStore } from './journal-db';
import {
  classifyKvConflict,
  hexTextOfAddressedBlob,
  kvConflictDetail,
} from './kv-compare';
import { readSessionKv } from './kv-session';
import { planFilePath, readPlanFile } from './plans';
import { sha256Hex } from './resource-bytes';
import { installBlobFile } from './resource-files';
import { SqliteSession } from './sqlite-session';
import { writeFile } from './trace-fs';
import { canvasesDirOf, inspectPair, plansDirOf } from './transfer-context';
import { traceIO, transferEvent } from './transfer-events';
import type { SqliteConn, TransferContext, WorkspaceEntry } from './types';
import { TransferError } from './types';

/** Destination paths for plans, canvases, and images already written. */
export async function resourceMaps(opts: {
  /** Catalog ordinal of this chat. */
  ordinal: number;
  /** Temporary index of the bundle. */
  work: SqliteSession;
  /** Destination plans directory. */
  plansDir: string;
  /** Destination canvases directory, or null when this workspace has none. */
  canvasesDir: string | null;
  /** Destination workspace, used to locate images. */
  workspace: WorkspaceEntry;
}): Promise<{
  /** Plan basename to the destination file path. */
  plans: Map<string, string>;
  /** Canvas basename to the destination file path. */
  canvases: Map<string, string>;
  /** Image basename to the destination file path. */
  images: Map<string, string>;
}> {
  const plans = new Map<string, string>();
  const canvases = new Map<string, string>();
  const images = new Map<string, string>();
  const imageRoot = attachmentDirectory(opts.workspace);

  try {
    const { readdir } = await import('node:fs/promises');

    for (const name of await readdir(opts.plansDir)) {
      plans.set(name, planFilePath(opts.plansDir, name));
    }

    if (opts.canvasesDir) {
      for (const name of await readdir(opts.canvasesDir)) {
        canvases.set(name, canvasFilePath(opts.canvasesDir, name));
      }
    }
  } catch {
    /* directory may not exist yet */
  }

  await opts.work.queryLines(
    `SELECT json_object('class', class, 'id', id, 'filename', filename, 'extension', extension, 'aliases', aliases) FROM res WHERE ordinal = ${opts.ordinal};`,
    (line) => {
      const row = json<{
        /** Resource class stored in the work index. */
        class: string;
        /** Resource id. */
        id: string;
        /** Basename for a file resource. */
        filename: string;
        extension: string;
        /** JSON list of other basenames with these bytes. */
        aliases: string;
      }>(line);

      if (row.class === 'plan' && row.filename) {
        plans.set(row.filename, planFilePath(opts.plansDir, row.filename));
      }

      if (row.class === 'canvas' && row.filename && opts.canvasesDir) {
        canvases.set(
          row.filename,
          canvasFilePath(opts.canvasesDir, row.filename),
        );
      }

      if (row.class === 'image') {
        const filename = row.filename || `${row.id}.${row.extension || 'bin'}`;
        const dest = path.join(imageRoot, filename);

        images.set(filename, dest);
        for (const alias of JSON.parse(row.aliases || '[]') as string[])
          images.set(alias, dest);
      }
    },
  );

  return { plans, canvases, images };
}

/** Copy image, plan, and canvas bytes into the workspace. */
export async function copyResources(opts: {
  /** Transfer hooks and cancellation. */
  ctx: TransferContext;
  /** Extracted bundle root. */
  root: string;
  /** Catalog ordinal of this chat. */
  ordinal: number;
  /** Temporary index of the bundle. */
  work: SqliteSession;
  workspace: WorkspaceEntry;
  /** Destination plans directory. */
  plansDir: string;
  /** Destination canvases directory, or null when this workspace has none. */
  canvasesDir: string | null;
}): Promise<void> {
  const rows: Array<{
    /** Resource class recorded in the work index. */
    class: string;
    /** Resource id recorded in the work index. */
    id: string;
    sha256: string;
    /** Bundle filename, when the resource is a file. */
    filename: string;
    /** File extension recorded for images. */
    extension: string;
  }> = [];

  await opts.work.queryLines(
    `SELECT json_object('class', class, 'id', id, 'sha256', sha256, 'filename', filename, 'extension', extension, 'aliases', aliases) FROM res WHERE ordinal = ${opts.ordinal};`,
    (line) => rows.push(json(line)),
  );

  for (const row of rows) {
    if (row.class === 'kv') continue;

    const blob = path.join(
      opts.root,
      'blobs',
      row.sha256.slice(0, 2),
      `${row.sha256}.bin`,
    );

    const filename =
      row.filename ||
      (row.class === 'image' ? `${row.id}.${row.extension || 'bin'}` : row.id);

    const root =
      row.class === 'plan'
        ? opts.plansDir
        : row.class === 'canvas'
          ? opts.canvasesDir || ''
          : path.join(path.dirname(opts.workspace.workspaceDbPath), 'images');

    if (!root) continue;

    await installBlobFile(
      root,
      path.join(root, path.basename(filename)),
      blob,
      opts.ctx.signal,
    );
  }
}

/** Insert cursorDiskKV blob rows that are not already present. */
export async function insertKv(
  global: SqliteSession,
  opts: {
    /** Catalog ordinal of this chat. */
    ordinal: number;
    /** Temporary index of the bundle. */
    work: SqliteSession;
    /** Extracted bundle root. */
    root: string;
    /** Transfer hooks and cancellation. */
    ctx: TransferContext;
  },
): Promise<void> {
  const rows: Array<{
    /** cursorDiskKV key. */
    id: string;
    sha256: string;
    storage_class: string;
  }> = [];

  await opts.work.queryLines(
    `SELECT json_object('id', id, 'sha256', sha256, 'storage_class', storage_class) FROM res WHERE ordinal = ${opts.ordinal} AND class = 'kv';`,
    (line) => rows.push(json(line)),
  );

  let processed = 0;
  let last = performance.now();

  /** Report resource progress for staging. */
  const report = () =>
    opts.ctx.onPhase?.('prepare', {
      scope: 'stage-resources',
      processed,
      total: rows.length,
      unit: 'resources',
    });

  report();

  for (const row of rows) {
    opts.ctx.signal?.throwIfAborted();

    const blob = path.join(
      opts.root,
      'blobs',
      row.sha256.slice(0, 2),
      `${row.sha256}.bin`,
    );

    const value =
      row.storage_class === 'blob'
        ? `readfile(${sqlText(blob)})`
        : `CAST(readfile(${sqlText(blob)}) AS TEXT)`;

    await global.exec(
      `INSERT INTO cursorDiskKV(key, value) SELECT ${sqlText(row.id)}, ${value}
       WHERE NOT EXISTS (SELECT 1 FROM cursorDiskKV WHERE key = ${sqlText(row.id)});`,
    );

    processed++;

    if (processed === rows.length || performance.now() - last >= 250) {
      last = performance.now();
      report();
    }
  }
}

/** SHA-256 of a resource already stored at the destination. */
export async function reusedSha(
  opts: {
    /** Transfer hooks and cancellation. */
    ctx: TransferContext;
    workspace: WorkspaceEntry;
    /** Open destination databases and their layouts. */
    pair: Awaited<ReturnType<typeof inspectPair>>;
  },
  kind: string,
  /** Resource id. */
  id: string,
): Promise<string | null> {
  if (kind === 'kv') {
    const row = await db.readKvBytes(opts.pair.connGl, id);

    return row ? sha256Hex(row.bytes) : null;
  }

  if (kind === 'plan') {
    const file = await readPlanFile(plansDirOf(opts.ctx), id);

    return file ? file.sha256 : null;
  }

  if (kind === 'canvas') {
    const dir = canvasesDirOf(opts.ctx, opts.workspace);

    if (!dir) return null;
    const file = await readCanvasFile(dir, id);

    return file ? file.sha256 : null;
  }

  if (kind === 'image') {
    const found = await resolveAttachmentPath(opts.workspace, id);

    if (!found) return null;

    return (await hashFile(found.filePath)).sha256;
  }

  return null;
}

/** True when this chat's resources were refused before any of its files or rows were written. */
export function isPreflightKvConflict(
  /** Failure raised while comparing one chat's resources. */
  err: unknown,
): boolean {
  return (
    err instanceof TransferError &&
    err.code === 'RESOURCE_CONFLICT' &&
    typeof err.detail === 'string' &&
    err.detail.startsWith('phase=preflight ')
  );
}

/** Fail when an existing blob key has different bytes or storage class. */
export async function assertKvCompatible(opts: {
  /** Transfer hooks and cancellation. */
  ctx: TransferContext;
  /** Catalog ordinal of this chat. */
  ordinal: number;
  /** Temporary index of the bundle. */
  work: SqliteSession;
  /** Open destination databases and their layouts. */
  pair: Awaited<ReturnType<typeof inspectPair>>;
  /** Extracted bundle root. */
  root: string;
}): Promise<void> {
  const rows: Array<{
    /** cursorDiskKV key. */
    id: string;
    sha256: string;
    storage_class: string;
    byte_length: number;
  }> = [];

  await opts.work.queryLines(
    `SELECT json_object('id', id, 'sha256', sha256, 'storage_class', storage_class, 'byte_length', byte_length) FROM res WHERE ordinal = ${opts.ordinal} AND class = 'kv';`,
    (line) => rows.push(json(line)),
  );

  let processed = 0;
  let last = performance.now();

  /** Report resource progress for the compatibility check. */
  const report = () =>
    opts.ctx.onPhase?.('prepare', {
      processed,
      total: rows.length,
      unit: 'resources',
      scope: 'assertKvCompatible',
      file: opts.pair.connGl.database,
    });

  report();

  const repairs: Array<{
    /** cursorDiskKV key. */
    key: string;
    /** SHA-256 of the stored bytes at preflight. */
    previousSha256: string;
    /** Incoming blob the hex text should decode to. */
    incoming: {
      /** Declared storage class of the incoming value. */
      storageClass: string;
      /** SHA-256 of the incoming bytes. */
      sha256: string;
      /** Decoded byte length of the incoming value. */
      byteLength: number;
    };
  }> = [];

  const session = await SqliteSession.open({
    ...opts.pair.connGl,
    readOnly: true,
  });

  try {
    for (const row of rows) {
      opts.ctx.signal?.throwIfAborted();

      await traceIO(
        'Check existing chat resource',
        { path: opts.pair.connGl.database, key: row.id },
        async () => {
          const existing = await readSessionKv(session, row.id);

          if (!existing) return;

          const incoming = {
            storageClass: row.storage_class || 'blob',
            sha256: row.sha256,
            byteLength: Number(row.byte_length) || 0,
          };

          const facts = classifyKvConflict(existing, incoming);

          if (!facts) return;

          const decoded = hexTextOfAddressedBlob(existing, incoming, row.id);

          if (decoded) {
            repairs.push({
              key: row.id,
              previousSha256: facts.existingSha256,
              incoming,
            });

            return;
          }

          const err = new TransferError(
            'A required chat resource already exists with different data.',
          );

          err.code = 'RESOURCE_CONFLICT';
          err.detail = kvConflictDetail(facts, row.id, 'preflight');

          throw err;
        },
      );

      processed++;

      if (processed === rows.length || performance.now() - last >= 250) {
        last = performance.now();
        report();
      }
    }
  } finally {
    await session.close();
  }

  for (const repair of repairs) {
    opts.ctx.signal?.throwIfAborted();

    // Retain only metadata during preflight. Load one repair body at a time.
    const reader = await SqliteSession.open({
      ...opts.pair.connGl,
      readOnly: true,
    });

    let existing;

    try {
      existing = await readSessionKv(reader, repair.key);
    } finally {
      await reader.close();
    }

    if (existing && !classifyKvConflict(existing, repair.incoming)) continue;

    const decoded =
      existing && sha256Hex(existing.bytes) === repair.previousSha256
        ? hexTextOfAddressedBlob(existing, repair.incoming, repair.key)
        : null;

    if (!existing || !decoded) {
      const err = new TransferError(
        'A required chat resource changed before repair.',
      );

      err.code = 'RESOURCE_CONFLICT';
      err.detail = `phase=preflight reason=content key=${repair.key}`;

      throw err;
    }

    await restoreHexEncodedBlob(opts.pair.connGl, {
      key: repair.key,
      previous: existing.bytes,
      decoded,
    });
  }
}

/** Replace one hex-text cell with the raw blob it spells. Leave the row when it changed. */
export async function restoreHexEncodedBlob(
  conn: SqliteConn,
  repair: {
    /** cursorDiskKV key. */
    key: string;
    /** Stored hex text that must still be present. */
    previous: Buffer;
    /** Raw bytes the hex text spells. */
    decoded: Buffer;
  },
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cct-blob-'));
  const previousPath = path.join(dir, 'previous.bin');
  const decodedPath = path.join(dir, 'decoded.bin');

  try {
    await writeFile(previousPath, repair.previous, { mode: 0o600 });
    await writeFile(decodedPath, repair.decoded, { mode: 0o600 });

    const session = await SqliteSession.open({ ...conn, readOnly: false });

    try {
      await session.exec(`BEGIN IMMEDIATE;
UPDATE cursorDiskKV SET value = readfile(${sqlText(decodedPath)})
WHERE key = ${sqlText(repair.key)}
  AND typeof(value) = 'text'
  AND CAST(value AS BLOB) = readfile(${sqlText(previousPath)});`);

      const changed = Number((await session.exec('SELECT changes();')).trim());

      const stored =
        changed === 1 ? await readSessionKv(session, repair.key) : null;

      const restored =
        stored?.storageClass === 'blob' &&
        sha256Hex(stored.bytes) === sha256Hex(repair.decoded);

      await session.exec(restored ? 'COMMIT;' : 'ROLLBACK;');

      if (!restored) {
        const err = new TransferError(
          'A required chat resource already exists with different data.',
        );

        err.code = 'RESOURCE_CONFLICT';
        err.detail = `phase=preflight reason=content key=${repair.key}`;

        throw err;
      }
    } finally {
      await session.close();
    }

    transferEvent({
      action: 'Restore hex-encoded blob',
      status: 'completed',
      path: conn.database,
      key: repair.key,
      bytes: repair.decoded.length,
      detail: `previousClass=text previousBytes=${repair.previous.length} restoredClass=blob restoredBytes=${repair.decoded.length}`,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Confirm written blob keys still match the bundle hashes. */
export async function verifyStoredResources(opts: {
  /** Transfer hooks and cancellation. */
  ctx: TransferContext;
  /** Catalog ordinal of this chat. */
  ordinal: number;
  /** Temporary index of the bundle. */
  work: SqliteSession;
  /** Open destination databases and their layouts. */
  pair: Awaited<ReturnType<typeof inspectPair>>;
}): Promise<void> {
  const rows: Array<{
    /** cursorDiskKV key. */
    id: string;
    sha256: string;
    storage_class: string;
    byte_length: number;
  }> = [];

  await opts.work.queryLines(
    `SELECT json_object('id', id, 'sha256', sha256, 'storage_class', storage_class, 'byte_length', byte_length) FROM res WHERE ordinal = ${opts.ordinal} AND class = 'kv';`,
    (line) => rows.push(json(line)),
  );

  let processed = 0;
  let last = performance.now();

  /** Report resource progress for verification. */
  const report = () =>
    opts.ctx.onPhase?.('verify', {
      processed,
      total: rows.length,
      unit: 'resources',
      scope: 'verifyStoredResources',
      file: opts.pair.connGl.database,
    });

  report();

  const session = await SqliteSession.open({
    ...opts.pair.connGl,
    readOnly: true,
  });

  try {
    for (const row of rows) {
      opts.ctx.signal?.throwIfAborted();

      await traceIO(
        'Verify stored chat resource',
        { path: opts.pair.connGl.database, key: row.id },
        async () => {
          const stored = await readSessionKv(session, row.id);

          const facts = stored
            ? classifyKvConflict(stored, {
                storageClass: row.storage_class || 'blob',
                sha256: row.sha256,
                byteLength: Number(row.byte_length) || 0,
              })
            : null;

          if (!stored || facts) {
            const err = new TransferError(
              'Import verification failed for a chat resource.',
            );

            err.code = 'PARTIAL';
            if (facts) err.detail = kvConflictDetail(facts, row.id, 'verify');

            throw err;
          }
        },
      );

      processed++;

      if (processed === rows.length || performance.now() - last >= 250) {
        last = performance.now();
        report();
      }
    }
  } finally {
    await session.close();
  }
}

/** Record expected resource hashes on the pending journal batch. */
export async function rememberResources(opts: {
  /** Catalog ordinal of this chat. */
  ordinal: number;
  /** Temporary index of the bundle. */
  work: SqliteSession;
  /** Receipt store for this destination. */
  journal: JournalStore;
  /** Pending operation that will own these hashes. */
  operationId: string;
  /** Scanned source and target ids for this chat. */
  row: ChatRow;
}): Promise<void> {
  const rows: Array<{
    /** Resource class recorded in the work index. */
    class: string;
    /** Resource id recorded in the work index. */
    id: string;
    sha256: string;
    /** Bundle filename, when the resource is a file. */
    filename: string;
  }> = [];

  await opts.work.queryLines(
    `SELECT json_object('class', class, 'id', id, 'sha256', sha256, 'filename', filename) FROM res WHERE ordinal = ${opts.ordinal};`,
    (line) => rows.push(json(line)),
  );

  for (const row of rows) {
    const id = row.class === 'kv' ? row.id : row.filename || row.id;

    await opts.journal.addPendingResource(
      opts.operationId,
      opts.row.targetId,
      row.class,
      id,
      row.sha256,
    );
  }
}
