import { textRecovery } from './text-recovery';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { MAX_SQLITE_VALUE_BYTES } from './bundle-limits';
import { ordinalName } from './bundle-names';
import type { BundleResourceRef, ConversationLayout } from './bundle-writer';
import { canvasFilenamesFromChat, isCanvasFilename } from './canvases';
import { sqlText } from './core';
import {
  blobKeysFromComposerBody,
  imageUuidsFromBubbles,
  isBlobKey,
  readBlobGraph,
} from './dependencies';
import { hashFile } from './hash-file';
import {
  asObject,
  attention,
  isSkippableChat,
  json,
  ndjsonFiles,
  Plan,
} from './import-bundle-common';
import { reusedSha } from './import-bundle-resources';
import { classifyTargetObservation, decideImport } from './import-policy';
import { observeTargetComposer } from './import-reconcile';
import { JournalStore } from './journal-db';
import { readNdjson } from './ndjson-io';
import { isPlanFilename, planFilenamesFromChat } from './plans';
import { readMeasuredNdjson } from './progress-reader';
import { parseBoundedJson } from './record-json';
import { SnapshotHasher } from './snapshot-hash';
import { SqliteSession } from './sqlite-session';
import { readFile } from './trace-fs';
import { inspectPair } from './transfer-context';
import { inChat } from './transfer-events';
import type { BubbleRecord, TransferContext, WorkspaceEntry } from './types';
import { TransferError } from './types';

/** Classify every chat in the bundle against the destination. */
export async function scanAll(opts: {
  /** Transfer hooks and cancellation. */
  ctx: TransferContext;
  /** Extracted bundle root. */
  root: string;
  /** Temporary index of the bundle. */
  work: SqliteSession;
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
            name: typeof rec.name === 'string' ? rec.name : undefined,
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
export async function scanChat(
  opts: {
    /** Transfer hooks and cancellation. */
    ctx: TransferContext;
    /** Extracted bundle root. */
    root: string;
    /** Temporary index of the bundle. */
    work: SqliteSession;
    workspace: WorkspaceEntry;
    /** Open destination databases and their layouts. */
    pair: Awaited<ReturnType<typeof inspectPair>>;
  },
  /** Catalog ordinal of this chat. */
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
      onPhase: (
        phase,
        /** Progress counts for this phase. */
        metrics,
      ) =>
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
    {
      /** Resource class required by this chat. */
      kind: 'kv' | 'image' | 'plan' | 'canvas';
      /** Resource id required by this chat. */
      id: string;
    }
  >();

  /** Remember one resource identity for this chat. */
  const need = (
    kind: 'kv' | 'image' | 'plan' | 'canvas',
    /** Resource id. */
    id: string,
  ) => needs.set(JSON.stringify([kind, id]), { kind, id });

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

  if (missingReference) {
    const error = new TransferError(
      `Missing message body ${missingReference} referenced by chat ${sourceId}.`,
    );

    error.code = 'MISSING_MESSAGE';

    throw error;
  }

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

  const kvRows: Array<{
    /** cursorDiskKV key. */
    id: string;
    sha256: string;
  }> = [];

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

  const quality =
    missing || textRecovery(fields.cctTextRecovery)
      ? 'history-only'
      : 'complete';

  hasher.quality(quality);

  return { hash: hasher.digest(), quality, targetId };
}

/** Mark blob ids reachable from conversation state, including nested records. */
export async function noteReachableBlobs(
  /** Conversation state whose blob pointers are walked. */
  state: unknown,
  /** Extracted bundle root. */
  root: string,
  /** Blob rows already recorded for this chat. */
  rows: Array<{
    /** cursorDiskKV key. */
    id: string;
    sha256: string;
  }>,
  /** Called once for each reachable resource. */
  note: (kind: 'kv' | 'image' | 'plan' | 'canvas', id: string) => void,
  /** Transfer hooks and cancellation. */
  ctx: TransferContext,
): Promise<void> {
  const paths = new Map(
    rows.map((row) => [row.id.slice('agentKv:blob:'.length), row.sha256]),
  );

  let processed = 0;
  let last = performance.now();

  ctx.onPhase?.('collect', { processed, unit: 'resources' });

  const closed = await readBlobGraph(
    state,
    async (/** Blob digests for this call. */ digests) => {
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
    },
  );

  if (closed.status !== 'ok') {
    throw new TransferError(
      'This chat uses an unsupported conversation state format.',
    );
  }

  for (const key of closed.keys) note('kv', key);
  for (const key of closed.missing) note('kv', key);
}

/** Validate resource metadata before using it in paths or database rows. */
export function validateResourceRef(
  /** One resource object from the bundle. */
  value: unknown,
): BundleResourceRef {
  const ref = asObject(value, 'resource');

  /** True when the value is a safe plan or canvas filename. */
  const basename = (
    /** Candidate filename. */
    name: unknown,
  ): name is string =>
    typeof name === 'string' &&
    name.length > 0 &&
    name !== '.' &&
    name !== '..' &&
    !/[\\/:]/.test(name) &&
    !Array.from(name).some(
      (/** One character. */ char) => char.charCodeAt(0) < 32,
    );

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
export function dependencyFrom(
  need: {
    /** Resource class recorded in the work index. */
    kind: string;
    /** Resource id recorded in the work index. */
    id: string;
  },
  row: {
    sha256: string;
    byte_length: number;
    /** SQLite storage class for a kv value. */
    storage_class: string;
    /** Basename written for a file resource. */
    filename: string;
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
