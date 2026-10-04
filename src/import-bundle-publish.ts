import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { rewriteImageReferences } from './attachments';
import { MAX_SQLITE_VALUE_BYTES } from './bundle-limits';
import { ordinalName } from './bundle-names';
import type { ConversationLayout } from './bundle-writer';
import { rewriteCanvasReferences } from './canvases';
import { remapJsonObject } from './chat-json';
import { sqlText } from './core';
import * as db from './db';
import { headerUpsertSql, isCasConflict, itemCasReplaceSql } from './db-write';
import { hashFile } from './hash-file';
import { writePreparedBatches } from './import-batches';
import {
  asObject,
  ChatRow,
  ndjsonFiles,
  stringList,
} from './import-bundle-common';
import {
  assertKvCompatible,
  copyResources,
  insertKv,
  rememberResources,
  resourceMaps,
  verifyStoredResources,
} from './import-bundle-resources';
import {
  bindWorkspace,
  CAS_ATTEMPTS,
  mergeComposerList,
  parseItemObject,
} from './import-commit';
import { sha256Text } from './import-policy';
import { JournalStore } from './journal-db';
import { KV_ROW_MISMATCH_SQL } from './kv-compare';
import { readNdjson } from './ndjson-io';
import { rewritePlanReferences } from './plans';
import { parseBoundedJson } from './record-json';
import { BUBBLE_BODY_POINTERS, BUBBLE_KEYED_FIELDS } from './schema';
import { execSql } from './sqlite';
import { SqliteSession } from './sqlite-session';
import { readFile } from './trace-fs';
import { connOf, inspectPair } from './transfer-context';
import { traceIO, transferEvent } from './transfer-events';
import type { ComposerHeader, TransferContext, WorkspaceEntry } from './types';
import { TransferError } from './types';

/** Import one accepted chat and record its journal receipt. */
export async function writeOne(opts: {
  /** Transfer hooks and cancellation. */
  ctx: TransferContext;
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
export async function assembleComposer(
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
    workspace: WorkspaceEntry;
  },
  /** Extracted chat directory. */
  dir: string,
  /** Destination composer.json path. */
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

  /** Append one fragment and refuse a composer past the SQLite value limit. */
  const append = async (
    /** Text appended to the rebuilt composer file. */
    text: string,
  ) => {
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

/** Rewrite composer and bubble ids and resource paths for the destination. */
export async function remapValue(
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
    workspace: WorkspaceEntry;
  },
  /** Composer or bubble record to rewrite. */
  value: unknown,
  /** Source bubble id, empty for the composer itself. */
  sourceBubbleId: string,
  /** Destination bubble id, empty for the composer itself. */
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

  /** Gather pointer keys from one object. */
  const collect = (
    /** Nested record that may hold resource pointers. */
    value: unknown,
    /** Property names that store those pointers. */
    keys: readonly string[],
  ) => {
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

/** CAS-write the composer header into the workspace item table. */
export async function writeWorkspace(
  opts: {
    /** Transfer hooks and cancellation. */
    ctx: TransferContext;
    workspace: WorkspaceEntry;
    /** Open destination databases and their layouts. */
    pair: Awaited<ReturnType<typeof inspectPair>>;
    /** Scanned source and target ids for this chat. */
    row: ChatRow;
  },
  /** Composer header bound to the destination workspace. */
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
