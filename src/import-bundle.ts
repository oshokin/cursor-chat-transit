import { readMeasuredNdjson } from './progress-reader';
import { readSessionKv } from './kv-session';
import { writePreparedBatches } from './import-batches';
import { cleanUnpublishedBubbles } from './import-cleanup';
import { inChat, transferEvent, traceIO } from './transfer-events';
import { readFile, writeFile } from './trace-fs';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openBundle } from './bundle-reader';
import { ordinalName } from './bundle-names';
import { MAX_SQLITE_VALUE_BYTES } from './bundle-limits';
import { BUBBLE_KEYED_FIELDS, BUBBLE_BODY_POINTERS } from './schema';
import type { BundleResourceRef, ConversationLayout } from './bundle-writer';
import {
  attachmentDirectory,
  resolveAttachmentPath,
  rewriteImageReferences,
} from './attachments';
import {
  canvasFilePath,
  isCanvasFilename,
  readCanvasFile,
  rewriteCanvasReferences,
} from './canvases';
import {
  isPlanFilename,
  planFilePath,
  readPlanFile,
  rewritePlanReferences,
} from './plans';
import { remapJsonObject } from './chat-json';
import { sqlText } from './core';
import * as db from './db';
import { headerUpsertSql, isCasConflict, itemCasReplaceSql } from './db-write';
import { CAS_ATTEMPTS } from './import-commit';
import {
  blobKeysFromComposerBody,
  isBlobKey,
  readBlobGraph,
} from './dependencies';
import {
  bindWorkspace,
  mergeComposerList,
  parseItemObject,
} from './import-commit';
import {
  classifyTargetObservation,
  decideImport,
  sha256Text,
} from './import-policy';
import {
  assertStoredListsReadable,
  observeTargetComposer,
  pendingResourceMatches,
  probeTargetComposer,
} from './import-reconcile';
import { targetKeyFor } from './journal';
import { JournalStore } from './journal-db';
import { acquireLock } from './lock';
import { readNdjson } from './ndjson-io';
import { hashFile } from './hash-file';
import {
  classifyKvConflict,
  hexTextOfAddressedBlob,
  KV_ROW_MISMATCH_SQL,
  kvConflictDetail,
} from './kv-compare';
import { sha256Hex } from './resource-bytes';
import { installBlobFile } from './resource-files';
import { parseBoundedJson } from './record-json';
import { SnapshotHasher } from './snapshot-hash';
import { ensureInitFile, execSql, findSqliteExecutable } from './sqlite';
import { SqliteSession } from './sqlite-session';
import {
  canvasesDirOf,
  connOf,
  inspectPair,
  plansDirOf,
} from './transfer-context';
import type {
  ComposerHeader,
  ImportResult,
  SqliteConn,
  TransferContext,
  WorkspaceEntry,
} from './types';
import { TransferError } from './types';
import { canvasFilenamesFromChat } from './canvases';
import { planFilenamesFromChat } from './plans';
import { imageUuidsFromBubbles } from './dependencies';
import type { BubbleRecord } from './types';

/** Import a v4 archive. JSON exports from older builds are rejected. */
export async function importFromBundle(
  ctx: TransferContext,
  zipPath: string,
  workspace: WorkspaceEntry,
  options?: {
    /** When true, import chats that are missing optional resources. */
    allowPartial?: boolean;
    /** Directory for the v4 receipt database. */
    journalDir?: string;
    /** Directory for the transfer lock. */
    lockDir?: string;
  },
): Promise<ImportResult> {
  const journalDir =
    options?.journalDir ||
    path.join(workspace.storageRoot, 'cursor-chat-transit');

  const targetKey = await targetKeyFor(workspace);

  const lock = await acquireLock(
    options?.lockDir ||
      path.join(
        path.dirname(workspace.globalDbPath),
        'cursor-chat-transit-locks',
      ),
    'import-global',
  );

  try {
    return await runImport(ctx, zipPath, workspace, {
      allowPartial: options?.allowPartial === true,
      journalDir,
      targetKey,
    });
  } finally {
    await lock.release();
  }
}

/** Unpack the bundle, scan chats, then write the ones the policy accepts. */
async function runImport(
  ctx: TransferContext,
  zipPath: string,
  workspace: WorkspaceEntry,
  options: {
    /** When true, keep readable history from an incomplete export. */
    allowPartial: boolean;
    /** Directory that holds the private journal database. */
    journalDir: string;
    /** Canonical target identity for that journal. */
    targetKey: string;
  },
): Promise<ImportResult> {
  ctx.onPhase?.('read');
  const bundle = await openBundle(zipPath, ctx.signal);
  const executable = ctx.executable || findSqliteExecutable();

  if (!executable) throw new Error('sqlite3 is required.');
  await mkdir(options.journalDir, { recursive: true });
  const initFile = await ensureInitFile(options.journalDir);

  let work: SqliteSession | undefined;
  let journal: JournalStore | undefined;

  try {
    work = await SqliteSession.open({
      executable,
      database: path.join(bundle.root, 'index.sqlite'),
      initFile,
      signal: ctx.signal,
      timeoutMs: ctx.timeoutMs,
      busyTimeoutMs: ctx.busyTimeoutMs,
    });

    journal = await JournalStore.open({
      executable,
      journalDir: options.journalDir,
      targetKey: options.targetKey,
      signal: ctx.signal,
    });

    await work.exec(`
CREATE TABLE chat (
  ordinal INTEGER PRIMARY KEY,
  source_id TEXT NOT NULL UNIQUE,
  snapshot_hash TEXT NOT NULL,
  quality TEXT NOT NULL,
  target_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT NOT NULL
);
CREATE TABLE bubble (
  ordinal INTEGER NOT NULL,
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  component TEXT NOT NULL,
  PRIMARY KEY (ordinal, source_id)
);
CREATE TABLE res (
  ordinal INTEGER NOT NULL,
  class TEXT NOT NULL,
  id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  storage_class TEXT,
  filename TEXT,
  extension TEXT,
  aliases TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX res_id ON res(ordinal,class,id);
CREATE INDEX res_name ON res(ordinal,class,filename);
CREATE TABLE referenced(ordinal INTEGER, id TEXT, PRIMARY KEY(ordinal,id));
CREATE TABLE dep (
  ordinal INTEGER NOT NULL,
  sort_key TEXT NOT NULL,
  canonical TEXT NOT NULL,
  PRIMARY KEY (ordinal, sort_key)
);`);

    const pair = await inspectPair(ctx, workspace);

    if (
      !pair.glInfo.layout.canWriteGlobal ||
      !pair.wsInfo.layout.canWriteWorkspace
    ) {
      throw new Error(
        pair.glInfo.layout.unsupportedReason ||
          'Refusing to write an unknown schema.',
      );
    }

    await assertStoredListsReadable({
      connWs: pair.connWs,
      connGl: pair.connGl,
      wsInfo: pair.wsInfo.layout,
      glInfo: pair.glInfo.layout,
    });

    await reconcile(journal, ctx, workspace, pair);
    ctx.onPhase?.('validate');

    await work.exec('BEGIN;');

    const plan = await scanAll({
      ctx,
      root: bundle.root,
      work,
      workspace,
      pair,
      journal,
      targetKey: options.targetKey,
      allowPartial: options.allowPartial,
    });

    await work.exec('COMMIT;');
    if (!plan.create.length) return resultFrom(plan, [], []);
    const operationId = randomUUID();

    await journal.beginPending({ operationId, phase: 'prepared' });
    const written: string[] = [];
    const historyOnlyIds: string[] = [];
    let durable = false;

    try {
      for (const [index, ordinal] of plan.create.entries()) {
        ctx.signal?.throwIfAborted();

        const row = await oneChat(work, ordinal);

        const header = asObject(
          parseBoundedJson(
            await readFile(
              path.join(
                bundle.root,
                'chats',
                ordinalName(ordinal),
                'header.json',
              ),
            ),
            'header',
          ),
          'header',
        );

        const chatName =
          typeof header.name === 'string' ? header.name : row.sourceId;

        const chatIndex = index + 1;

        const chatCtx = {
          ...ctx,
          onPhase: (
            phase: import('./types').TransferPhase,
            metrics: import('./types').TransferPhaseMetrics = {},
          ) =>
            ctx.onPhase?.(phase, {
              ...metrics,
              chatName,
              chatIndex,
              chatTotal: plan.create.length,
            }),
        };

        try {
          await inChat(row.sourceId, chatName, () =>
            writeOne({
              ctx: chatCtx,
              workspace,
              pair,
              root: bundle.root,
              work: work!,
              journal: journal!,
              operationId,
              ordinal,
              row,
              plansDir: plansDirOf(ctx),
              canvasesDir: canvasesDirOf(ctx, workspace),
              onDurable: () => {
                durable = true;
              },
            }),
          );
        } catch (err) {
          if (!isPreflightKvConflict(err)) throw err;

          plan.skipped.push({
            composerId: row.sourceId,
            name: chatName,
            reason: 'a stored resource differs',
          });

          continue;
        }

        written.push(row.targetId);
        if (row.quality === 'history-only') historyOnlyIds.push(row.targetId);

        await journal.addReceipt({
          sourceComposerId: row.sourceId,
          snapshotHash: row.hash,
          targetComposerId: row.targetId,
          quality: row.quality,
        });
      }

      await journal.clearPending();
    } catch (err) {
      if (!written.length && !durable) {
        await journal.clearPending();

        throw err;
      }

      const wrapped = new TransferError(
        err instanceof Error ? err.message : String(err),
      );

      wrapped.code = 'PARTIAL';

      throw wrapped;
    }

    return resultFrom(plan, written, historyOnlyIds);
  } finally {
    await work?.close().catch(() => undefined);
    await journal?.close().catch(() => undefined);
    await bundle.close();
  }
}

/** Classify every chat in the bundle against the destination. */
async function scanAll(opts: {
  /** Transfer hooks and cancellation. */
  ctx: TransferContext;
  /** Extracted bundle root. */
  root: string;
  /** Temporary index of the bundle. */
  work: SqliteSession;
  /** Destination workspace. */
  workspace: WorkspaceEntry;
  /** Open destination databases and their layouts. */
  pair: Awaited<ReturnType<typeof inspectPair>>;
  /** Receipt store for this destination. */
  journal: JournalStore;
  /** Canonical target identity. */
  targetKey: string;
  /** When true, a history-only chat can still be imported. */
  allowPartial: boolean;
}): Promise<Plan> {
  const plan: Plan = {
    create: [],
    skipped: [],
    already: [],
    newVersions: [],
    restored: [],
  };

  const receipts = await opts.journal.receipts();

  for (const file of await ndjsonFiles(path.join(opts.root, 'catalog'))) {
    for await (const row of readNdjson(file, 'catalog', opts.ctx.signal)) {
      const rec = asObject(row.value, 'catalog row');
      const ordinal = rec.ordinal;
      const sourceId = rec.sourceComposerId;

      if (typeof ordinal !== 'number' || typeof sourceId !== 'string') {
        throw new Error('Catalog row is missing a chat id.');
      }

      let scanned: Awaited<ReturnType<typeof scanChat>>;

      try {
        scanned = await inChat(
          sourceId,
          typeof rec.name === 'string' ? rec.name : sourceId,
          () => scanChat(opts, ordinal, sourceId),
        );
      } catch (err) {
        if (opts.allowPartial && isSkippableChat(err)) {
          plan.skipped.push({
            composerId: sourceId,
            reason:
              err instanceof Error ? err.message : 'unsupported bubble payload',
          });

          continue;
        }

        throw err;
      }

      if (scanned.quality === 'history-only' && !opts.allowPartial) {
        const err = new TransferError(
          `Chat ${sourceId} is missing data. Partial import is off.`,
        );

        err.code = 'MISSING_DEPENDENCY';

        throw err;
      }

      const decision = await decideImport(
        {
          targetKey: opts.targetKey,
          sourceComposerId: sourceId,
          snapshotHash: scanned.hash,
        },
        receipts,
        async (targetComposerId) =>
          classifyTargetObservation(
            await observeTargetComposer({
              targetComposerId,
              workspace: opts.workspace,
              connWs: opts.pair.connWs,
              connGl: opts.pair.connGl,
              wsInfo: opts.pair.wsInfo.layout,
              glInfo: opts.pair.glInfo.layout,
            }),
          ),
      );

      const name = typeof rec.name === 'string' ? rec.name : undefined;

      const targetId =
        decision.action === 'skip'
          ? decision.targetComposerId
          : scanned.targetId;

      const reason =
        decision.action === 'create'
          ? decision.reason
          : decision.action === 'blocked'
            ? decision.reason
            : 'skip';

      await opts.work.exec(
        `INSERT INTO chat(ordinal, source_id, snapshot_hash, quality, target_id, decision, reason)
         VALUES (${ordinal}, ${sqlText(sourceId)}, ${sqlText(scanned.hash)}, ${sqlText(scanned.quality)}, ${sqlText(targetId)}, ${sqlText(decision.action)}, ${sqlText(reason)});`,
      );

      if (decision.action === 'blocked') {
        const targets = receipts
          .filter((row) => row.sourceComposerId === sourceId)
          .map((row) => row.targetComposerId)
          .join(' ');

        const err = attention(decision.reason, sourceId);

        err.detail = `${decision.reason} source=${sourceId} ${targets}`.trim();

        throw err;
      }

      if (decision.action === 'skip') {
        plan.already.push({
          composerId: sourceId,
          name,
          targetComposerId: decision.targetComposerId,
          reason: 'already imported',
        });

        continue;
      }

      plan.create.push(ordinal);

      if (decision.reason === 'different-snapshot') {
        plan.newVersions.push({
          composerId: sourceId,
          name,
          reason: 'updated version',
        });
      } else if (decision.reason === 'deleted-copy') {
        plan.restored.push({
          composerId: sourceId,
          name,
          reason: 'restored copy',
        });
      }
    }
  }

  return plan;
}

/** Fingerprint one chat and record the resources it needs. */
async function scanChat(
  opts: {
    /** Transfer hooks and cancellation. */
    ctx: TransferContext;
    /** Extracted bundle root. */
    root: string;
    /** Temporary index of the bundle. */
    work: SqliteSession;
    /** Destination workspace. */
    workspace: WorkspaceEntry;
    /** Open destination databases and their layouts. */
    pair: Awaited<ReturnType<typeof inspectPair>>;
  },
  ordinal: number,
  sourceId: string,
): Promise<{
  /** Canonical snapshot hash. */
  hash: string;
  /** complete or history-only. */
  quality: 'complete' | 'history-only';
  /** Destination composer id chosen for this copy. */
  targetId: string;
}> {
  const optsPhase = opts.ctx.onPhase;
  const dir = path.join(opts.root, 'chats', ordinalName(ordinal));

  const header = asObject(
    parseBoundedJson(await readFile(path.join(dir, 'header.json')), 'header'),
    'header',
  );

  if (header.composerId !== sourceId) {
    throw new Error(`Chat ${sourceId} header does not match the catalog.`);
  }

  const composer = asObject(
    parseBoundedJson(
      await readFile(path.join(dir, 'composer.json')),
      'composer',
    ),
    'composer',
  );

  opts = {
    ...opts,
    ctx: {
      ...opts.ctx,
      onPhase: (phase, metrics) =>
        optsPhase?.(phase, {
          ...metrics,
          chatName: typeof header.name === 'string' ? header.name : sourceId,
        }),
    },
  };

  const layout = composer.conversation as ConversationLayout;
  const fields = asObject(composer.fields, 'composer fields');
  const hasher = new SnapshotHasher();
  const targetId = randomUUID();

  hasher.source(sourceId);
  hasher.header(header);
  hasher.composer(fields);
  hasher.conversationState(layout === 'ndjson' ? 'present' : layout);

  const needs = new Map<
    string,
    { kind: 'kv' | 'image' | 'plan' | 'canvas'; id: string }
  >();

  const need = (kind: 'kv' | 'image' | 'plan' | 'canvas', id: string) =>
    needs.set(JSON.stringify([kind, id]), { kind, id });

  const bodyForDeps = JSON.stringify(fields);
  const blobs = blobKeysFromComposerBody(bodyForDeps);

  if (blobs.status === 'unsupported') {
    throw new TransferError(
      'This chat uses an unsupported conversation state format.',
    );
  }

  for (const key of blobs.keys) need('kv', key);

  for (const file of await ndjsonFiles(path.join(dir, 'conversation'))) {
    for await (const row of readMeasuredNdjson(
      file,
      `conversation ${sourceId}`,
      opts.ctx,
    )) {
      hasher.conversationItem(row.value);
      const item = asObject(row.value, 'conversation item');

      if (typeof item.bubbleId !== 'string')
        throw new Error(
          `Chat ${sourceId} has an invalid conversation reference.`,
        );

      await opts.work.exec(
        `INSERT OR IGNORE INTO referenced VALUES (${ordinal},${sqlText(item.bubbleId)});`,
      );
    }
  }

  for (const file of await ndjsonFiles(path.join(dir, 'bubbles'))) {
    for await (const row of readMeasuredNdjson(
      file,
      `bubble ${sourceId}`,
      opts.ctx,
    )) {
      const rec = asObject(row.value, 'bubble');
      const bubbleId = rec.bubbleId;

      if (typeof bubbleId !== 'string' || !bubbleId) {
        throw new Error(`Chat ${sourceId} has a bubble without an id.`);
      }

      if (
        !rec.payload ||
        typeof rec.payload !== 'object' ||
        Array.isArray(rec.payload)
      ) {
        throw new Error('unsupported bubble payload');
      }

      const exists = (
        await opts.work.exec(
          `SELECT source_id FROM bubble WHERE ordinal = ${ordinal} AND source_id = ${sqlText(bubbleId)};`,
        )
      ).trim();

      if (exists)
        throw new Error(`Chat ${sourceId} repeats message ${bubbleId}.`);

      const component = SnapshotHasher.bubbleComponent(bubbleId, rec.payload);

      const one: BubbleRecord = {
        key: `bubbleId:${sourceId}:${bubbleId}`,
        bubbleId,
        value: JSON.stringify(rec.payload),
      };

      for (const uuid of imageUuidsFromBubbles([one])) {
        need('image', uuid);
      }

      for (const name of planFilenamesFromChat('{}', [one])) {
        need('plan', name);
      }

      for (const name of canvasFilenamesFromChat('{}', [one])) {
        need('canvas', name);
      }

      await opts.work.exec(
        `INSERT INTO bubble(ordinal, source_id, target_id, component)
         VALUES (${ordinal}, ${sqlText(bubbleId)}, ${sqlText(randomUUID())}, ${sqlText(component)});`,
      );
    }
  }

  const missingReference = (
    await opts.work.exec(
      `SELECT r.id FROM referenced r LEFT JOIN bubble b ON b.ordinal=r.ordinal AND b.source_id=r.id WHERE r.ordinal=${ordinal} AND b.source_id IS NULL LIMIT 1;`,
    )
  ).trim();

  if (missingReference)
    throw new TransferError(
      `Missing bubble ${missingReference} referenced by chat ${sourceId}.`,
    );

  for (const name of planFilenamesFromChat(bodyForDeps, [])) {
    need('plan', name);
  }

  for (const name of canvasFilenamesFromChat(bodyForDeps, [])) {
    need('canvas', name);
  }

  await opts.work.queryLines(
    `SELECT component FROM bubble WHERE ordinal = ${ordinal} ORDER BY source_id;`,
    (line) => hasher.bubbleDigest(line),
  );

  const kvRows: Array<{ id: string; sha256: string }> = [];

  for (const file of await ndjsonFiles(path.join(dir, 'resources'))) {
    for await (const row of readMeasuredNdjson(
      file,
      `resource ${sourceId}`,
      opts.ctx,
    )) {
      const ref = validateResourceRef(row.value);

      if (ref.class === 'kv') kvRows.push({ id: ref.id, sha256: ref.sha256 });

      const blob = path.join(
        opts.root,
        'blobs',
        ref.sha256.slice(0, 2),
        `${ref.sha256}.bin`,
      );

      const hashed = await hashFile(blob, opts.ctx.signal);

      if (hashed.sha256 !== ref.sha256 || hashed.bytes !== ref.byteLength) {
        throw new Error('Attachment checksum does not match.');
      }

      await opts.work.exec(
        `INSERT INTO res(ordinal, class, id, sha256, byte_length, storage_class, filename, extension, aliases)
         VALUES (${ordinal}, ${sqlText(ref.class)}, ${sqlText(ref.id)}, ${sqlText(ref.sha256)}, ${Number(ref.byteLength) || 0}, ${sqlText(ref.storageClass || '')}, ${sqlText(ref.filename || '')}, ${sqlText(ref.extension || '')}, ${sqlText(JSON.stringify(ref.aliases || []))});`,
      );
    }
  }

  await noteReachableBlobs(
    fields.conversationState,
    opts.root,
    kvRows,
    need,
    opts.ctx,
  );

  let missing = false;

  for (const need of needs.values()) {
    const found = (
      await opts.work.exec(
        `SELECT json_object('sha256', sha256, 'byte_length', byte_length, 'storage_class', storage_class, 'filename', filename, 'extension', extension) FROM res
       WHERE ordinal = ${ordinal} AND class = ${sqlText(need.kind)}
       AND (id = ${sqlText(need.id)} OR filename = ${sqlText(need.id)});`,
      )
    ).trim();

    const dependencies: Record<string, unknown>[] = found
      ? found.split('\n').map((line) => dependencyFrom(need, json(line)))
      : [];

    if (!found) {
      const reused = await reusedSha(opts, need.kind, need.id);

      dependencies.push({
        kind: need.kind,
        id: need.id,
        sha256: reused || null,
      });

      if (!reused) missing = true;
    }

    for (const dep of dependencies) {
      await opts.work.exec(
        `INSERT OR IGNORE INTO dep(ordinal, sort_key, canonical) VALUES (${ordinal}, ${sqlText(JSON.stringify([dep.kind, dep.id]))}, ${sqlText(JSON.stringify(dep))});`,
      );
    }
  }

  await opts.work.queryLines(
    `SELECT canonical FROM dep WHERE ordinal = ${ordinal} ORDER BY sort_key;`,
    (line) => hasher.dependency(JSON.parse(line)),
  );

  const quality = missing ? 'history-only' : 'complete';

  hasher.quality(quality);

  return { hash: hasher.digest(), quality, targetId };
}

/** Mark blob ids reachable from conversation state, including nested records. */
async function noteReachableBlobs(
  state: unknown,
  root: string,
  rows: Array<{ id: string; sha256: string }>,
  note: (kind: 'kv' | 'image' | 'plan' | 'canvas', id: string) => void,
  ctx: TransferContext,
): Promise<void> {
  const paths = new Map(
    rows.map((row) => [row.id.slice('agentKv:blob:'.length), row.sha256]),
  );

  let processed = 0;
  let last = performance.now();

  ctx.onPhase?.('collect', { processed, unit: 'resources' });

  const closed = await readBlobGraph(state, async (digests) => {
    const batch = new Map<string, Buffer | null>();

    for (const digest of digests) {
      ctx.signal?.throwIfAborted();
      const sha = paths.get(digest);

      batch.set(
        digest,
        sha
          ? await readFile(
              path.join(root, 'blobs', sha.slice(0, 2), `${sha}.bin`),
            )
          : null,
      );
    }

    processed += digests.length;

    if (performance.now() - last >= 250) {
      last = performance.now();
      ctx.onPhase?.('collect', { processed, unit: 'resources' });
    }

    return batch;
  });

  if (closed.status !== 'ok') {
    throw new TransferError(
      'This chat uses an unsupported conversation state format.',
    );
  }

  for (const key of closed.keys) note('kv', key);
  for (const key of closed.missing) note('kv', key);
}

/** Validate resource metadata before using it in paths or database rows. */
function validateResourceRef(value: unknown): BundleResourceRef {
  const ref = asObject(value, 'resource');

  const basename = (name: unknown): name is string =>
    typeof name === 'string' &&
    name.length > 0 &&
    name !== '.' &&
    name !== '..' &&
    !/[\\/:]/.test(name) &&
    !Array.from(name).some((char) => char.charCodeAt(0) < 32);

  if (
    !['kv', 'image', 'plan', 'canvas'].includes(String(ref.class)) ||
    typeof ref.id !== 'string' ||
    !ref.id ||
    typeof ref.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(ref.sha256) ||
    !Number.isSafeInteger(ref.byteLength) ||
    Number(ref.byteLength) < 0
  )
    throw new Error('Invalid resource metadata.');

  if (ref.class === 'kv') {
    if (
      !isBlobKey(ref.id) ||
      !['text', 'blob'].includes(String(ref.storageClass)) ||
      Number(ref.byteLength) > MAX_SQLITE_VALUE_BYTES
    )
      throw new Error('Invalid SQLite resource metadata.');
  } else {
    const filename =
      ref.filename ??
      (ref.class === 'image' ? `${ref.id}.${ref.extension}` : ref.id);

    if (!basename(filename)) throw new Error('Invalid resource filename.');
    if (ref.class === 'plan' && !isPlanFilename(filename))
      throw new Error('Invalid plan filename.');
    if (ref.class === 'canvas' && !isCanvasFilename(filename))
      throw new Error('Invalid canvas filename.');
  }

  if (
    ref.aliases !== undefined &&
    (!Array.isArray(ref.aliases) || !ref.aliases.every(basename))
  )
    throw new Error('Invalid resource aliases.');

  return ref as unknown as BundleResourceRef;
}

/** Fingerprint row for one required resource. */
function dependencyFrom(
  need: {
    /** Resource class recorded in the work index. */
    kind: string;
    /** Resource id recorded in the work index. */
    id: string;
  },
  row: {
    /** SHA-256 of the resource bytes. */
    sha256: string;
    /** Decoded byte length. */
    byte_length: number;
    /** SQLite storage class for a kv value. */
    storage_class: string;
    /** Basename written for a file resource. */
    filename: string;
    /** Image extension. */
    extension: string;
  },
): Record<string, unknown> {
  return {
    kind: need.kind,
    id: need.kind === 'image' ? row.filename || need.id : need.id,
    sha256: row.sha256,
    byteLength: row.byte_length,
    ...(need.kind === 'kv' && row.storage_class
      ? { storageClass: row.storage_class }
      : {}),
    ...(need.kind === 'image' && row.extension
      ? { extension: row.extension }
      : {}),
  };
}

/** Import one accepted chat and record its journal receipt. */
async function writeOne(opts: {
  /** Transfer hooks and cancellation. */
  ctx: TransferContext;
  /** Destination workspace. */
  workspace: WorkspaceEntry;
  /** Open destination databases and their layouts. */
  pair: Awaited<ReturnType<typeof inspectPair>>;
  /** Extracted bundle root. */
  root: string;
  /** Temporary index of the bundle. */
  work: SqliteSession;
  /** Receipt store for this destination. */
  journal: JournalStore;
  /** Pending operation that will own this chat's receipt. */
  operationId: string;
  /** Catalog ordinal of this chat. */
  ordinal: number;
  /** Scanned source and target ids for this chat. */
  row: ChatRow;
  /** Destination plans directory. */
  plansDir: string;
  /** Destination canvases directory, or null when this workspace has none. */
  canvasesDir: string | null;
  /** Called after a durable batch is committed. */
  onDurable?: () => void;
}): Promise<void> {
  opts.ctx.onPhase?.('prepare', { chats: 1 });
  await assertKvCompatible(opts);
  const dir = path.join(opts.root, 'chats', ordinalName(opts.ordinal));
  const staging = await mkdtemp(path.join(os.tmpdir(), 'cct-write-'));

  try {
    await copyResources(opts);
    const composerPath = path.join(staging, 'composer.json');

    await assembleComposer(opts, dir, composerPath);
    const composerBytes = (await hashFile(composerPath)).bytes;

    if (composerBytes > MAX_SQLITE_VALUE_BYTES) {
      throw new TransferError(
        `Chat ${opts.row.sourceId} composer is ${composerBytes} bytes; the supported limit is ${MAX_SQLITE_VALUE_BYTES}.`,
      );
    }

    const composerHash = sha256Text(await readFile(composerPath, 'utf8'));

    await opts.journal.addPendingChat(opts.operationId, {
      sourceComposerId: opts.row.sourceId,
      snapshotHash: opts.row.hash,
      targetComposerId: opts.row.targetId,
      expectedComposerHash: composerHash,
      bubbleCount: 0,
      quality: opts.row.quality,
    });

    await rememberResources(opts);

    const header = asObject(
      parseBoundedJson(await readFile(path.join(dir, 'header.json')), 'header'),
      'header',
    ) as unknown as ComposerHeader;

    header.composerId = opts.row.targetId;

    const bound = bindWorkspace(
      header,
      opts.workspace.storageId,
      opts.workspace.identity,
    );

    const stagedPath = path.join(staging, 'rows.sqlite');

    const staged = await SqliteSession.open({
      ...opts.pair.connGl,
      database: stagedPath,
      readOnly: false,
    });

    const maps = await resourceMaps(opts);
    let bubbleCount = 0;

    const bubbleTotal = Number(
      (
        await opts.work.exec(
          `SELECT count(*) FROM bubble WHERE ordinal=${opts.ordinal};`,
        )
      ).trim(),
    );

    try {
      await staged.exec(
        'CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY, value); BEGIN;',
      );

      await opts.journal.beginPreparation();
      await insertKv(staged, opts);

      opts.ctx.onPhase?.('prepare', {
        chats: 1,
        processed: 0,
        total: bubbleTotal,
        unit: 'messages',
      });

      await staged.exec(
        `INSERT INTO cursorDiskKV VALUES (${sqlText(`composerData:${opts.row.targetId}`)}, CAST(readfile(${sqlText(composerPath)}) AS TEXT));`,
      );

      for (const file of await ndjsonFiles(path.join(dir, 'bubbles'))) {
        for await (const rec of readNdjson(file, 'bubble', opts.ctx.signal)) {
          const bubble = asObject(rec.value, 'bubble');
          const sourceBubble = String(bubble.bubbleId);

          const targetBubble = (
            await opts.work.exec(
              `SELECT target_id FROM bubble WHERE ordinal = ${opts.ordinal} AND source_id = ${sqlText(sourceBubble)};`,
            )
          ).trim();

          const payload = await remapValue(
            opts,
            bubble.payload,
            sourceBubble,
            targetBubble,
            maps,
          );

          const text = JSON.stringify(payload);

          if (Buffer.byteLength(text) > MAX_SQLITE_VALUE_BYTES) {
            throw new TransferError(
              `Chat ${opts.row.sourceId} message ${sourceBubble} exceeds ${MAX_SQLITE_VALUE_BYTES} bytes.`,
            );
          }

          await staged.exec(
            `INSERT INTO cursorDiskKV(key, value) VALUES (${sqlText(`bubbleId:${opts.row.targetId}:${targetBubble}`)}, ${sqlText(text)});`,
          );

          await opts.journal.addPendingBubble(
            opts.operationId,
            opts.row.targetId,
            targetBubble,
            sha256Text(text),
          );

          bubbleCount += 1;
          if (bubbleCount % 100 === 0)
            opts.ctx.onPhase?.('prepare', {
              processed: bubbleCount,
              total: bubbleTotal,
              unit: 'messages',
            });
        }
      }

      await opts.journal.setBubbleCount(
        opts.operationId,
        opts.row.targetId,
        bubbleCount,
      );

      await staged.exec('COMMIT;');
      await opts.journal.finishPreparation();
    } catch (error) {
      await opts.journal.cancelPreparation().catch(() => undefined);

      throw error;
    } finally {
      await staged.close();
    }

    opts.ctx.onPhase?.('write', { chats: 1 });

    await writePreparedBatches({
      conn: opts.pair.connGl,
      stagedPath,
      composerKey: `composerData:${opts.row.targetId}`,
      ctx: opts.ctx,
      onDurable: opts.onDurable,
    });

    let committed = false;
    let lastError: unknown;

    for (let attempt = 0; attempt < CAS_ATTEMPTS && !committed; attempt++) {
      const headerRaw = opts.pair.glInfo.layout.itemTable
        ? await db.reads.readItemText(
            opts.pair.connGl,
            'composer.composerHeaders',
          )
        : null;

      const global = await SqliteSession.open({
        executable: opts.pair.connGl.executable,
        database: opts.workspace.globalDbPath,
        initFile: opts.pair.connGl.initFile,
        signal: opts.ctx.signal,
        timeoutMs: opts.ctx.timeoutMs,
        busyTimeoutMs: opts.ctx.busyTimeoutMs,
      });

      try {
        // All JSON, filesystem and journal work has finished before the write lock.
        await global.exec(`ATTACH DATABASE ${sqlText(stagedPath)} AS staged;`);

        transferEvent({
          action: 'Publish prepared chat',
          status: 'started',
          path: opts.workspace.globalDbPath,
        });

        await global.exec(`BEGIN IMMEDIATE;
CREATE TEMP TABLE cct_copy_guard(ok INTEGER CHECK(ok=1));
INSERT INTO cct_copy_guard SELECT 0 FROM main.cursorDiskKV t JOIN staged.cursorDiskKV s USING(key)
WHERE s.key=${sqlText(`composerData:${opts.row.targetId}`)} AND (${KV_ROW_MISMATCH_SQL}) LIMIT 1;
INSERT INTO main.cursorDiskKV(key,value) SELECT s.key,s.value FROM staged.cursorDiskKV s
WHERE s.key=${sqlText(`composerData:${opts.row.targetId}`)} AND NOT EXISTS(SELECT 1 FROM main.cursorDiskKV t WHERE t.key=s.key);`);

        if (opts.pair.glInfo.layout.composerHeaders) {
          await global.exec(
            headerUpsertSql(
              [bound],
              opts.workspace.storageId,
              opts.pair.glInfo.layout.headerColumns,
            ),
          );
        }

        if (opts.pair.glInfo.layout.itemTable) {
          const blob = parseItemObject(headerRaw);

          await global.exec(
            itemCasReplaceSql('composer.composerHeaders', headerRaw, {
              ...blob,
              allComposers: mergeComposerList(blob.allComposers, [bound]),
            }),
          );
        }

        await traceIO(
          'Publish chat header',
          { path: opts.workspace.globalDbPath },
          () => global.exec('COMMIT;'),
        );

        committed = true;
        opts.onDurable?.();
      } catch (err) {
        lastError = err;

        if (!isCasConflict(err) || attempt === CAS_ATTEMPTS - 1) throw err;
      } finally {
        await global.close();
      }
    }

    if (!committed) throw lastError;

    opts.onDurable?.();

    transferEvent({
      action: 'Commit chat transaction',
      status: 'completed',
      path: opts.workspace.globalDbPath,
    });

    await opts.journal.setPhase(opts.operationId, 'global-written');
    opts.ctx.onPhase?.('global-commit', { chats: 1 });
    await writeWorkspace(opts, bound);
    await opts.journal.setPhase(opts.operationId, 'workspace-written');
    opts.ctx.onPhase?.('workspace-commit');
    opts.ctx.onPhase?.('verify', { chats: 1 });
    await verifyStoredResources(opts);

    const stored = await db.readKvText(
      opts.pair.connGl,
      `composerData:${opts.row.targetId}`,
    );

    if (!stored || sha256Text(stored) !== composerHash) {
      throw new TransferError(
        'Import verification failed for the composer body.',
      );
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** Rebuild composer JSON with destination ids and resource paths. */
async function assembleComposer(
  opts: {
    /** Transfer hooks and cancellation. */
    ctx: TransferContext;
    /** Catalog ordinal of this chat. */
    ordinal: number;
    /** Scanned source and target ids for this chat. */
    row: ChatRow;
    /** Temporary index of the bundle. */
    work: SqliteSession;
    /** Destination plans directory. */
    plansDir: string;
    /** Destination canvases directory, or null when this workspace has none. */
    canvasesDir: string | null;
    /** Destination workspace. */
    workspace: WorkspaceEntry;
  },
  dir: string,
  dest: string,
): Promise<void> {
  const composer = asObject(
    parseBoundedJson(
      await readFile(path.join(dir, 'composer.json')),
      'composer',
    ),
    'composer',
  );

  const layout = composer.conversation as ConversationLayout;
  const maps = await resourceMaps(opts);
  let fields = asObject(composer.fields, 'composer fields');

  fields = (await remapValue(opts, fields, '', '', maps)) as Record<
    string,
    unknown
  >;

  fields.composerId = opts.row.targetId;

  if (layout === 'empty') fields.fullConversationHeadersOnly = [];

  const { open } = await import('node:fs/promises');
  const output = await open(dest, 'wx');
  let bytes = 0;

  const append = async (text: string) => {
    bytes += Buffer.byteLength(text);
    if (bytes > MAX_SQLITE_VALUE_BYTES)
      throw new Error(
        `Composer ${opts.row.sourceId} exceeds ${MAX_SQLITE_VALUE_BYTES} bytes: ${dest}`,
      );
    await output.writeFile(text);
  };

  try {
    if (layout !== 'ndjson') {
      await append(JSON.stringify(fields));

      return;
    }

    await append(
      JSON.stringify(fields).slice(0, -1) + ',"fullConversationHeadersOnly":[',
    );

    let first = true;

    for (const file of await ndjsonFiles(path.join(dir, 'conversation'))) {
      for await (const row of readNdjson(
        file,
        'conversation',
        opts.ctx.signal,
      )) {
        const value = await remapValue(opts, row.value, '', '', maps);

        await append((first ? '' : ',') + JSON.stringify(value));
        first = false;
      }
    }

    await append(']}');
  } finally {
    await output.close();
  }
}

/** Destination paths for plans, canvases, and images already written. */
async function resourceMaps(opts: {
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
        /** Image extension. */
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

/** Rewrite composer and bubble ids and resource paths for the destination. */
async function remapValue(
  opts: {
    /** Catalog ordinal of this chat. */
    ordinal: number;
    /** Scanned source and target ids for this chat. */
    row: ChatRow;
    /** Temporary index of the bundle. */
    work: SqliteSession;
    /** Destination plans directory. */
    plansDir: string;
    /** Destination canvases directory, or null when this workspace has none. */
    canvasesDir: string | null;
    /** Destination workspace. */
    workspace: WorkspaceEntry;
  },
  value: unknown,
  sourceBubbleId: string,
  targetBubbleId: string,
  maps?: {
    /** Plan basename to the destination file path. */
    plans: Map<string, string>;
    /** Canvas basename to the destination file path. */
    canvases: Map<string, string>;
    /** Image basename to the destination file path. */
    images: Map<string, string>;
  },
): Promise<Record<string, unknown>> {
  const record = asObject(value, 'chat record');
  const ids = new Map<string, string>([[opts.row.sourceId, opts.row.targetId]]);

  if (sourceBubbleId && targetBubbleId) ids.set(sourceBubbleId, targetBubbleId);

  // Query only known schema references in this bounded record, never the whole chat.
  const references = new Set<string>();

  const collect = (value: unknown, keys: readonly string[]) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const item = value as Record<string, unknown>;

    for (const key of keys)
      if (typeof item[key] === 'string') references.add(item[key]);
  };

  const pointerKeys = BUBBLE_BODY_POINTERS.map((pointer) => pointer.slice(1));

  collect(record, pointerKeys);

  for (const field of BUBBLE_KEYED_FIELDS) {
    const value = record[field];

    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;

    for (const [id, nested] of Object.entries(value)) {
      references.add(id);
      collect(nested, pointerKeys);
    }
  }

  if (Array.isArray(record.fullConversationHeadersOnly)) {
    for (const header of record.fullConversationHeadersOnly)
      collect(header, ['bubbleId']);
  }

  if (
    record.originalFileStates &&
    typeof record.originalFileStates === 'object'
  ) {
    for (const state of Object.values(record.originalFileStates))
      collect(state, ['firstEditBubbleId']);
  }

  const unresolved = [...references].filter((id) => !ids.has(id));

  for (let offset = 0; offset < unresolved.length; offset += 200) {
    const batch = unresolved.slice(offset, offset + 200);

    await opts.work.queryLines(
      `SELECT json_array(source_id, target_id) FROM bubble WHERE ordinal = ${opts.ordinal} AND source_id IN (${batch.map(sqlText).join(',')});`,
      (line) => {
        const pair = JSON.parse(line) as [string, string];

        ids.set(pair[0], pair[1]);
      },
    );
  }

  const bubbles = new Map(ids);

  bubbles.delete(opts.row.sourceId);

  let rewritten = remapJsonObject(record, ids, bubbles) as Record<
    string,
    unknown
  >;

  if (maps) {
    rewritten = rewritePlanReferences(rewritten, maps.plans) as Record<
      string,
      unknown
    >;

    rewritten = rewriteCanvasReferences(rewritten, maps.canvases) as Record<
      string,
      unknown
    >;

    rewritten = rewriteImageReferences(rewritten, maps.images) as Record<
      string,
      unknown
    >;
  }

  rewritten.composerId = opts.row.targetId;
  if (targetBubbleId) rewritten.bubbleId = targetBubbleId;

  return rewritten;
}

/** Copy image, plan, and canvas bytes into the workspace. */
async function copyResources(opts: {
  /** Transfer hooks and cancellation. */
  ctx: TransferContext;
  /** Extracted bundle root. */
  root: string;
  /** Catalog ordinal of this chat. */
  ordinal: number;
  /** Temporary index of the bundle. */
  work: SqliteSession;
  /** Destination workspace. */
  workspace: WorkspaceEntry;
  /** Destination plans directory. */
  plansDir: string;
  /** Destination canvases directory, or null when this workspace has none. */
  canvasesDir: string | null;
}): Promise<void> {
  const rows: Array<{
    class: string;
    id: string;
    sha256: string;
    filename: string;
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
async function insertKv(
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
  const rows: Array<{ id: string; sha256: string; storage_class: string }> = [];

  await opts.work.queryLines(
    `SELECT json_object('id', id, 'sha256', sha256, 'storage_class', storage_class) FROM res WHERE ordinal = ${opts.ordinal} AND class = 'kv';`,
    (line) => rows.push(json(line)),
  );

  let processed = 0;
  let last = performance.now();

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

/** CAS-write the composer header into the workspace item table. */
async function writeWorkspace(
  opts: {
    /** Transfer hooks and cancellation. */
    ctx: TransferContext;
    /** Destination workspace. */
    workspace: WorkspaceEntry;
    /** Open destination databases and their layouts. */
    pair: Awaited<ReturnType<typeof inspectPair>>;
    /** Scanned source and target ids for this chat. */
    row: ChatRow;
  },
  bound: ComposerHeader,
): Promise<void> {
  if (!opts.pair.wsInfo.layout.itemTable) return;

  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
    const raw = await db.readItemText(
      opts.pair.connWs,
      'composer.composerData',
    );

    const current = parseItemObject(raw);
    const selected = stringList(current.selectedComposerIds);
    const focused = stringList(current.lastFocusedComposerIds);

    if (!selected.includes(opts.row.targetId)) selected.push(opts.row.targetId);
    focused.unshift(opts.row.targetId);

    try {
      await execSql({
        ...connOf(opts.ctx, opts.workspace.workspaceDbPath, false),
        readOnly: false,
        sql: [
          'BEGIN IMMEDIATE;',
          itemCasReplaceSql('composer.composerData', raw, {
            ...current,
            selectedComposerIds: selected,
            lastFocusedComposerIds: focused.slice(0, 10),
            allComposers: mergeComposerList(current.allComposers, [bound]),
          }),
          'COMMIT;',
        ].join('\n'),
      });

      return;
    } catch (err) {
      if (isCasConflict(err) && attempt < CAS_ATTEMPTS - 1) continue;
      if (isCasConflict(err)) throw err;

      const wrapped = new TransferError(
        err instanceof Error ? err.message : String(err),
      );

      wrapped.code = 'PARTIAL';

      throw wrapped;
    }
  }
}

/** Finish or repair a journal pending batch against what was stored. */
async function reconcile(
  journal: JournalStore,
  ctx: TransferContext,
  workspace: WorkspaceEntry,
  pair: Awaited<ReturnType<typeof inspectPair>>,
): Promise<void> {
  const pending = await journal.pending();

  if (!pending) return;
  const chats = await journal.pendingChats(pending.operationId);

  if (!chats.length) {
    await journal.clearPending();

    return;
  }

  const verified: typeof chats = [];

  for (const chat of chats) {
    const body = await db.readKvText(
      pair.connGl,
      `composerData:${chat.targetComposerId}`,
    );

    if (!body) {
      await cleanUnpublishedBubbles({
        journal,
        operationId: pending.operationId,
        chat,
        conn: pair.connGl,
        layout: pair.glInfo.layout,
      });

      continue;
    }

    if (sha256Text(body) !== chat.expectedComposerHash) {
      throw pendingProblem(chat.targetComposerId, chat.sourceComposerId);
    }

    const bubbles: Array<[string, string]> = [];

    await journal.forEachBubble(
      pending.operationId,
      chat.targetComposerId,
      (id, hash) => {
        bubbles.push([id, hash]);
      },
    );

    if (
      bubbles.length !== chat.bubbleCount ||
      (await db.listBubbleIds(pair.connGl, chat.targetComposerId)).size !==
        chat.bubbleCount
    ) {
      throw pendingProblem(chat.targetComposerId, chat.sourceComposerId);
    }

    for (const [id, hash] of bubbles) {
      const text = await db.readKvText(
        pair.connGl,
        `bubbleId:${chat.targetComposerId}:${id}`,
      );

      if (!text || sha256Text(text) !== hash) {
        throw pendingProblem(chat.targetComposerId, chat.sourceComposerId);
      }
    }

    const known = await journal.resourcesKnown(
      pending.operationId,
      chat.targetComposerId,
    );

    if (!known) {
      throw pendingProblem(chat.targetComposerId, chat.sourceComposerId);
    }

    const resources: Array<{
      kind: 'kv' | 'image' | 'plan' | 'canvas';
      id: string;
      sha256: string;
    }> = [];

    await journal.forEachResource(
      pending.operationId,
      chat.targetComposerId,
      (kind, id, sha256) => {
        if (
          kind === 'kv' ||
          kind === 'image' ||
          kind === 'plan' ||
          kind === 'canvas'
        ) {
          resources.push({ kind, id, sha256 });
        }
      },
    );

    for (const dep of resources) {
      const matches = await pendingResourceMatches(dep, {
        workspace,
        connGl: pair.connGl,
        plansDir: plansDirOf(ctx),
        canvasesDir: canvasesDirOf(ctx, workspace),
      });

      if (!matches) {
        throw pendingProblem(chat.targetComposerId, chat.sourceComposerId);
      }
    }

    const observed = await probeTargetComposer({
      targetComposerId: chat.targetComposerId,
      workspace,
      connWs: pair.connWs,
      connGl: pair.connGl,
      wsInfo: pair.wsInfo.layout,
      glInfo: pair.glInfo.layout,
    });

    if (observed !== 'available') {
      throw pendingProblem(chat.targetComposerId, chat.sourceComposerId);
    }

    verified.push(chat);
  }

  // Preserve verified completed chats while allowing an interrupted later chat to retry.
  for (const chat of verified) {
    await journal.addReceipt({
      sourceComposerId: chat.sourceComposerId,
      snapshotHash: chat.snapshotHash,
      targetComposerId: chat.targetComposerId,
      quality: chat.quality,
    });
  }

  await journal.clearPending();
}

/** Source and destination identity for one scanned chat. */
interface ChatRow {
  /** Composer id in the bundle. */
  sourceId: string;
  /** Composer id that will be written. */
  targetId: string;
  /** Snapshot hash used for the import decision. */
  hash: string;
  /** `complete` when the blob closure is present, otherwise history only. */
  quality: 'complete' | 'history-only';
}

/** Chats grouped by the import decision. */
interface Plan {
  /** Ordinals of chats that will be inserted. */
  create: number[];
  /** Chats the operator chose not to import. */
  skipped: ImportResult['skippedChats'];
  /** Chats already present at the same snapshot. */
  already: ImportResult['alreadyImportedChats'];
  /** Chats whose snapshot differs from the destination. */
  newVersions: ImportResult['newVersionChats'];
  /** Chats recovered from a previous interrupted import. */
  restored: NonNullable<ImportResult['restoredChats']>;
}

/** Load one scanned chat row from the work database. */
async function oneChat(work: SqliteSession, ordinal: number): Promise<ChatRow> {
  const row = json<{
    /** Source composer id. */
    source_id: string;
    /** Destination composer id. */
    target_id: string;
    /** Canonical snapshot hash. */
    snapshot_hash: string;
    /** complete or history-only. */
    quality: 'complete' | 'history-only';
  }>(
    (
      await work.exec(
        `SELECT json_object('source_id', source_id, 'target_id', target_id, 'snapshot_hash', snapshot_hash, 'quality', quality) FROM chat WHERE ordinal = ${ordinal};`,
      )
    ).trim(),
  );

  return {
    sourceId: row.source_id,
    targetId: row.target_id,
    hash: row.snapshot_hash,
    quality: row.quality,
  };
}

/** ImportResult counts from the plan and the chats that were written. */
function resultFrom(
  plan: Plan,
  written: string[],
  historyOnlyIds: string[],
): ImportResult {
  return {
    imported: written.length,
    complete: written.length - historyOnlyIds.length,
    historyOnly: historyOnlyIds.length,
    skipped: plan.skipped.length,
    alreadyImported: plan.already.length,
    alreadyPresent: plan.already.length,
    newVersions: plan.newVersions.length,
    restored: plan.restored.length,
    incomplete: 0,
    composerIds: written,
    historyOnlyIds,
    skippedChats: plan.skipped,
    alreadyImportedChats: plan.already,
    newVersionChats: plan.newVersions,
    restoredChats: plan.restored,
  };
}

/** NEEDS_ATTENTION for a chat left in a pending import. */
function pendingProblem(targetId: string, sourceId: string): TransferError {
  const err = attention('pending-import', sourceId);

  err.detail = `pending phase pendingTarget=${targetId} source=${sourceId}`;

  return err;
}

/** True when a chat body cannot be remapped and may be skipped. */
function isSkippableChat(err: unknown): boolean {
  const message = err instanceof Error ? err.message : '';

  return (
    message.includes('is not an object') ||
    message.includes('unsupported bubble payload')
  );
}

/** SHA-256 of a resource already stored at the destination. */
async function reusedSha(
  opts: {
    /** Transfer hooks and cancellation. */
    ctx: TransferContext;
    /** Destination workspace. */
    workspace: WorkspaceEntry;
    /** Open destination databases and their layouts. */
    pair: Awaited<ReturnType<typeof inspectPair>>;
  },
  kind: string,
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
function isPreflightKvConflict(err: unknown): boolean {
  return (
    err instanceof TransferError &&
    err.code === 'RESOURCE_CONFLICT' &&
    typeof err.detail === 'string' &&
    err.detail.startsWith('phase=preflight ')
  );
}

/** Fail when an existing blob key has different bytes or storage class. */
async function assertKvCompatible(opts: {
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
    key: string;
    previousSha256: string;
    incoming: { storageClass: string; sha256: string; byteLength: number };
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
async function restoreHexEncodedBlob(
  conn: SqliteConn,
  repair: { key: string; previous: Buffer; decoded: Buffer },
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
async function verifyStoredResources(opts: {
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
async function rememberResources(opts: {
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
    class: string;
    id: string;
    sha256: string;
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

/** NEEDS_ATTENTION error that names the source chat. */
function attention(reason: string, sourceId: string): TransferError {
  const err = new TransferError(
    'The previous import needs checking. No new copies were created.',
  );

  err.code = 'NEEDS_ATTENTION';
  err.detail = `${reason} source=${sourceId}`;

  return err;
}

/** Require a JSON object. */
function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is not an object.`);
  }

  return value as Record<string, unknown>;
}

/** Parse one NDJSON line. */
function json<T>(line: string): T {
  return JSON.parse(line) as T;
}

/** Require an array of strings. */
function stringList(value: unknown): string[] {
  if (value === undefined) return [];

  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new TransferError('composer id list is not an array of strings.');
  }

  return value.slice() as string[];
}

/** Sorted `.ndjson` paths, or none when the directory is missing. */
async function ndjsonFiles(dir: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises');

  try {
    return (await readdir(dir))
      .filter((name) => name.endsWith('.ndjson'))
      .sort()
      .map((name) => path.join(dir, name));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];

    throw err;
  }
}
