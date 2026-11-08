import {
  assertVisualizationScope,
  readVisualizationFile,
  provisionVisualizationScope,
  visualizationScopeFiles,
} from './visualizations';
import {
  historicalDestination,
  historicalProjectRoot,
  parseHistoricalResourceId,
  assertDistinctTranscriptOwners,
  transcriptRelativePath,
} from './historical-artifacts';
import { readFile } from './trace-fs';
import { MAX_SQLITE_VALUE_BYTES } from './bundle-limits';
import { TRANSFER_PROGRESS_THROTTLE_MS } from './progress-model';
import path from 'node:path';
import { attachmentDirectory, resolveAttachmentPath } from './attachments';
import { canvasFilePath, readCanvasFile } from './canvases';
import {
  classifyChatKvKey,
  remapChatKvJson,
  remapChatKvKey,
} from './chat-kv-registry';
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
import { canvasesDirOf, inspectPair, plansDirOf } from './transfer-context';
import { traceIO, transferEvent } from './transfer-events';
import type { SqliteConn, TransferContext, WorkspaceEntry } from './types';
import { TransferError } from './types';

interface FileResourceRow {
  class: string;
  id: string;
  sha256: string;
  filename: string;
  extension: string;
}

/** Journal identity of one destination path, independent of its display filename. */
export function fileEffectId(target: string): string {
  return `file:${sha256Hex(Buffer.from(path.resolve(target)))}`;
}

/** Absolute destination. Missing optional roots return null and are not planned. */
export async function resourceFileTarget(opts: {
  ctx: TransferContext;
  workspace: WorkspaceEntry;
  plansDir: string;
  canvasesDir: string | null;
  owner: string;
  ownerMap: ReadonlyMap<string, string>;
  row: Pick<FileResourceRow, 'class' | 'id' | 'filename' | 'extension'>;
}): Promise<string | null> {
  const filename = path.basename(
    opts.row.filename ||
      (opts.row.class === 'image'
        ? `${opts.row.id}.${opts.row.extension || 'bin'}`
        : opts.row.id),
  );

  if (
    opts.row.class === 'transcript' ||
    opts.row.class === 'terminal-history'
  ) {
    const project = historicalProjectRoot(opts.ctx, opts.workspace);

    if (!project)
      throw new Error('Destination project artifact root unavailable.');

    return historicalDestination(
      project,
      opts.row.class,
      opts.row.id,
      opts.owner,
      opts.ownerMap,
    );
  }

  if (opts.row.class === 'visualization') {
    return path.join(
      await visualizationScopeFiles(opts.ctx, opts.workspace, opts.owner),
      'visualizations',
      filename,
    );
  }

  if (opts.row.class === 'plan') return path.join(opts.plansDir, filename);

  if (opts.row.class === 'canvas') {
    return opts.canvasesDir ? path.join(opts.canvasesDir, filename) : null;
  }

  return path.join(
    path.dirname(opts.workspace.workspaceDbPath),
    'images',
    filename,
  );
}

async function importedOwnerContext(
  work: SqliteSession,
  ordinal: number,
): Promise<{ owner: string; ownerMap: Map<string, string> }> {
  const owner = (
    await work.exec(`SELECT target_id FROM chat WHERE ordinal=${ordinal};`)
  ).trim();

  const ownerMap = new Map<string, string>();

  await work.queryLines(
    "SELECT json_object('source',source_id,'target',target_id) FROM chat;",
    (line) => {
      const row = json<{ source: string; target: string }>(line);

      ownerMap.set(row.source, row.target);
    },
  );

  return { owner, ownerMap };
}

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
  ctx?: TransferContext;
}): Promise<{
  /** Plan basename to the destination file path. */
  plans: Map<string, string>;
  /** Canvas basename to the destination file path. */
  canvases: Map<string, string>;
  /** Image basename to the destination file path. */
  images: Map<string, string>;
  historical: Map<string, string>;
  transcripts: Map<string, string>;
}> {
  const plans = new Map<string, string>();
  const canvases = new Map<string, string>();
  const images = new Map<string, string>();
  const historical = new Map<string, string>();
  const transcripts = new Map<string, string>();

  const owner = (
    await opts.work.exec(
      `SELECT target_id FROM chat WHERE ordinal=${opts.ordinal};`,
    )
  ).trim();

  const sourceOwner = (
    await opts.work.exec(
      `SELECT source_id FROM chat WHERE ordinal=${opts.ordinal};`,
    )
  ).trim();

  const ownerMap = new Map<string, string>();

  await opts.work.queryLines(
    "SELECT json_object('source',source_id,'target',target_id) FROM chat;",
    (line) => {
      const row = json<{ source: string; target: string }>(line);

      ownerMap.set(row.source, row.target);
    },
  );

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

      if (row.class === 'transcript' || row.class === 'terminal-history') {
        const project = historicalProjectRoot(opts.ctx || {}, opts.workspace);

        if (!project)
          throw new Error('Destination project artifact root unavailable.');
        const metadata = parseHistoricalResourceId(row.id, row.class);

        const destination = historicalDestination(
          project,
          row.class,
          row.id,
          owner,
          ownerMap,
        );

        if (metadata.terminalName && metadata.sourceRoot)
          historical.set(
            metadata.sourceFile ||
              path.join(
                metadata.sourceRoot,
                'terminals',
                metadata.terminalName,
              ),
            destination,
          );
        if (row.class === 'transcript' && metadata.sourceRoot)
          transcripts.set(
            path.join(
              metadata.sourceRoot,
              'agent-transcripts',
              transcriptRelativePath(
                sourceOwner,
                metadata.layout!,
                metadata.extension!,
                metadata.parent,
              ),
            ),
            destination,
          );
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

  return { plans, canvases, images, historical, transcripts };
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
  /** Receipt store that owns these prepared file effects. */
  journal: JournalStore;
  /** Pending operation that owns these prepared file effects. */
  operationId: string;
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

  const { owner, ownerMap } = await importedOwnerContext(
    opts.work,
    opts.ordinal,
  );

  assertDistinctTranscriptOwners(ownerMap.values());

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

    if (row.class === 'transcript' || row.class === 'terminal-history') {
      const destination = await resourceFileTarget({
        ...opts,
        owner,
        ownerMap,
        row,
      });

      if (!destination)
        throw new Error('Destination project artifact root unavailable.');

      await assertVisualizationScope(
        path.dirname(destination),
        historicalProjectRoot(opts.ctx, opts.workspace) ?? undefined,
      );

      const effectId = fileEffectId(destination);

      await opts.journal.setEffectState(opts.operationId, effectId, 'prepared');

      await installBlobFile(
        path.dirname(destination),
        destination,
        blob,
        opts.ctx.signal,
      );

      const observed = await hashFile(destination, opts.ctx.signal);

      if (observed.sha256 !== row.sha256)
        throw new Error('Historical artifact verification failed.');

      await opts.journal.setEffectState(
        opts.operationId,
        effectId,
        'verified',
        observed.sha256,
      );

      continue;
    }

    const destination = await resourceFileTarget({
      ...opts,
      owner,
      ownerMap,
      row,
    });

    if (!destination) continue;

    if (row.class === 'visualization') {
      await provisionVisualizationScope(opts.ctx, opts.workspace, owner);
      await assertVisualizationScope(path.dirname(destination));
    }

    const root = path.dirname(destination);
    const effectId = fileEffectId(destination);

    await opts.journal.setEffectState(opts.operationId, effectId, 'prepared');

    await installBlobFile(
      root,
      path.join(root, path.basename(filename)),
      blob,
      opts.ctx.signal,
    );

    const observed = await hashFile(path.join(root, path.basename(filename)));

    await opts.journal.setEffectState(
      opts.operationId,
      effectId,
      observed.sha256 === row.sha256 ? 'verified' : 'applied',
      observed.sha256,
    );
  }
}

/** Persist every file intent before resource installation can touch the workspace. */
export async function planResourceEffects(opts: {
  ordinal: number;
  work: SqliteSession;
  journal: JournalStore;
  operationId: string;
  ctx: TransferContext;
  workspace: WorkspaceEntry;
  plansDir: string;
  canvasesDir: string | null;
}): Promise<void> {
  const rows: FileResourceRow[] = [];

  await opts.work.queryLines(
    `SELECT json_object('class',class,'id',id,'sha256',sha256,'filename',filename,'extension',extension)
     FROM res WHERE ordinal=${opts.ordinal} AND class <> 'kv';`,
    (line) => rows.push(json(line)),
  );

  const { owner, ownerMap } = await importedOwnerContext(
    opts.work,
    opts.ordinal,
  );

  for (const row of rows) {
    const target = await resourceFileTarget({ ...opts, owner, ownerMap, row });

    if (!target) continue;

    await opts.journal.planEffect({
      operationId: opts.operationId,
      effectId: fileEffectId(target),
      kind: 'file',
      target,
      desiredHash: row.sha256,
    });
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
    /** Source and destination composer ids used for renderer remapping. */
    row: ChatRow;
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

    const sourceBytes = await readFile(blob);

    const transformed = transformRendererKv(
      row.id,
      sourceBytes,
      opts.row.sourceId,
      opts.row.targetId,
    );

    const bytes = transformed.bytes;

    if (bytes.length > MAX_SQLITE_VALUE_BYTES)
      throw new Error('Resource exceeds SQLite value limit.');

    await global.exec(
      `INSERT INTO cursorDiskKV(key,value) SELECT ?, ${row.storage_class === 'blob' ? '?' : 'CAST(? AS TEXT)'} WHERE NOT EXISTS(SELECT 1 FROM cursorDiskKV WHERE key=?);`,
      [transformed.key, bytes, transformed.key],
    );

    processed++;

    if (
      processed === rows.length ||
      performance.now() - last >= TRANSFER_PROGRESS_THROTTLE_MS
    ) {
      last = performance.now();
      report();
    }
  }
}

/** Remap a renderer key and schema-known JSON references, preserving all else. */
export function transformRendererKv(
  key: string,
  bytes: Buffer,
  sourceComposerId: string,
  targetComposerId: string,
): { key: string; bytes: Buffer } {
  const classified = classifyChatKvKey(key);

  if (!classified) return { key, bytes };
  const ids = new Map([[sourceComposerId, targetComposerId]]);
  const mappedKey = remapChatKvKey(key, ids);

  try {
    const value: unknown = JSON.parse(bytes.toString('utf8'));

    if (!value || typeof value !== 'object') return { key: mappedKey, bytes };

    return {
      key: mappedKey,
      bytes: Buffer.from(JSON.stringify(remapChatKvJson(value, ids))),
    };
  } catch {
    return { key: mappedKey, bytes };
  }
}

/** SHA-256 of a resource already stored at the destination. */
export async function reusedSha(
  opts: {
    /** Transfer hooks and cancellation. */
    ctx: TransferContext;
    workspace: WorkspaceEntry;
    targetComposerId?: string;
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

  if (kind === 'visualization') {
    if (!opts.targetComposerId) return null;

    const scope = await visualizationScopeFiles(
      opts.ctx,
      opts.workspace,
      opts.targetComposerId,
    );

    return (
      (await readVisualizationFile(scope, id, opts.ctx.signal))?.sha256 ?? null
    );
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
  /** Source and destination composer ids. */
  row: ChatRow;
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

      const blob = path.join(
        opts.root,
        'blobs',
        row.sha256.slice(0, 2),
        `${row.sha256}.bin`,
      );

      const transformed = transformRendererKv(
        row.id,
        await readFile(blob),
        opts.row.sourceId,
        opts.row.targetId,
      );

      const incomingSha = sha256Hex(transformed.bytes);

      await traceIO(
        'Check existing chat resource',
        { path: opts.pair.connGl.database, key: transformed.key },
        async () => {
          const existing = await readSessionKv(session, transformed.key);

          if (!existing) return;

          const incoming = {
            storageClass: row.storage_class || 'blob',
            sha256: incomingSha,
            byteLength: transformed.bytes.length,
          };

          const facts = classifyKvConflict(existing, incoming);

          if (!facts) return;

          const decoded = hexTextOfAddressedBlob(
            existing,
            incoming,
            transformed.key,
          );

          if (decoded) {
            repairs.push({
              key: transformed.key,
              previousSha256: facts.existingSha256,
              incoming,
            });

            return;
          }

          const err = new TransferError(
            'A required chat resource already exists with different data.',
          );

          err.code = 'RESOURCE_CONFLICT';
          err.detail = kvConflictDetail(facts, transformed.key, 'preflight');

          throw err;
        },
      );

      processed++;

      if (
        processed === rows.length ||
        performance.now() - last >= TRANSFER_PROGRESS_THROTTLE_MS
      ) {
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
  const session = await SqliteSession.open({ ...conn, readOnly: false });

  try {
    transferEvent({
      action: 'Restore hex-encoded blob',
      status: 'started',
      path: conn.database,
      key: repair.key,
      bytes: repair.decoded.length,
    });

    await session.exec('BEGIN IMMEDIATE;');

    await session.exec(
      "UPDATE cursorDiskKV SET value=? WHERE key=? AND typeof(value)='text' AND CAST(value AS BLOB)=?;",
      [repair.decoded, repair.key, repair.previous],
    );

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
  /** Extracted bundle root. */
  root: string;
  /** Source and destination composer ids used for renderer remapping. */
  row: ChatRow;
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

      const blob = path.join(
        opts.root,
        'blobs',
        row.sha256.slice(0, 2),
        `${row.sha256}.bin`,
      );

      const transformed = transformRendererKv(
        row.id,
        await readFile(blob),
        opts.row.sourceId,
        opts.row.targetId,
      );

      await traceIO(
        'Verify stored chat resource',
        { path: opts.pair.connGl.database, key: transformed.key },
        async () => {
          const stored = await readSessionKv(session, transformed.key);

          const facts = stored
            ? classifyKvConflict(stored, {
                storageClass: row.storage_class || 'blob',
                sha256: sha256Hex(transformed.bytes),
                byteLength: transformed.bytes.length,
              })
            : null;

          if (!stored || facts) {
            const err = new TransferError(
              'Import verification failed for a chat resource.',
            );

            err.code = 'PARTIAL';
            if (facts)
              err.detail = kvConflictDetail(facts, transformed.key, 'verify');

            throw err;
          }
        },
      );

      processed++;

      if (
        processed === rows.length ||
        performance.now() - last >= TRANSFER_PROGRESS_THROTTLE_MS
      ) {
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
  /** Extracted bundle root. */
  root: string;
}): Promise<void> {
  const rows: Array<{
    class: string;
    id: string;
    sha256: string;
    filename: string;
  }> = [];

  await opts.work.queryLines(
    `SELECT json_object('class', class, 'id', id, 'sha256', sha256, 'filename', filename) FROM res WHERE ordinal = ${opts.ordinal};`,
    (line) => {
      rows.push(json(line));
    },
  );

  for (const row of rows) {
    let id = row.class === 'kv' ? row.id : row.filename || row.id;
    let sha256 = row.sha256;

    if (row.class === 'kv' && classifyChatKvKey(row.id)) {
      const blob = path.join(
        opts.root,
        'blobs',
        row.sha256.slice(0, 2),
        `${row.sha256}.bin`,
      );

      const transformed = transformRendererKv(
        row.id,
        await readFile(blob),
        opts.row.sourceId,
        opts.row.targetId,
      );

      id = transformed.key;
      sha256 = sha256Hex(transformed.bytes);
    }

    await opts.journal.addPendingResource(
      opts.operationId,
      opts.row.targetId,
      row.class,
      id,
      sha256,
    );
  }
}
