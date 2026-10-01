import * as db from './db';
import { fileUriMetadata } from './file-uri';
import { writeCanvasFile } from './canvases';
import { decodeSqliteBytes, writeAttachmentFile } from './dependencies';
import { prepareImport } from './import-prepare';
import { writePlanFile } from './plans';
import { execSqlScript } from './sqlite';
import { connOf, inspectPair } from './transfer-context';
import type {
  ComposerHeader,
  SqliteConn,
  TransferContext,
  WorkspaceEntry,
  WorkspaceIdentity,
} from './types';
import { TransferError } from './types';

/** Compare-and-swap retries when Cursor writes headers during import. */
export const CAS_ATTEMPTS = 5;

/** Copy a string-id list. A missing field is empty; any other shape is refused. */
function stringList(value: unknown): string[] {
  if (value === undefined) return [];

  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== 'string' || !item)
  ) {
    throw new TransferError('composer id list is not an array of strings.');
  }

  return value.slice();
}

/** Append headers that are not already in `current`. A non-array is refused. */
export function mergeComposerList(
  current: unknown,
  extra: ComposerHeader[],
): ComposerHeader[] {
  if (current !== undefined && !Array.isArray(current)) {
    throw new TransferError('composer list is not an array.');
  }

  const list = Array.isArray(current) ? (current as ComposerHeader[]) : [];

  const have = new Set(
    list
      .map((c) => c && c.composerId)
      .filter((id): id is string => Boolean(id)),
  );

  return list.concat(
    extra.filter((c) => c && c.composerId && !have.has(c.composerId)),
  );
}

/** Parse stored ItemTable JSON, or an empty object when the key is missing. */
export function parseItemObject(raw: string | null): Record<string, unknown> {
  if (raw === null) return {};

  if (raw === '') {
    throw new TransferError('ItemTable value is empty.');
  }

  const parsed: unknown = JSON.parse(raw);

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TransferError('ItemTable value is not a JSON object.');
  }

  return parsed as Record<string, unknown>;
}

/** Retry a write transaction when CAS sees a concurrent metadata change. */
export async function commitWithCas(
  ctx: TransferContext,
  writeConn: SqliteConn,
  _readConn: SqliteConn,
  usesItemCas: boolean,
  buildSql: () => Promise<string>,
): Promise<void> {
  let last: unknown;

  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
    ctx.signal?.throwIfAborted();

    try {
      const out = await execSqlScript({ ...writeConn, sql: await buildSql() });

      if (usesItemCas && out.includes('cas-conflict')) {
        last = Object.assign(new Error('cas-conflict'), { stderr: out });
        if (attempt === CAS_ATTEMPTS - 1) throw last;
        continue;
      }

      return;
    } catch (err) {
      const stderr =
        err && typeof err === 'object' && 'stderr' in err
          ? String(err.stderr)
          : '';

      if (
        db.isResourceConflict(err) ||
        stderr.includes('cct_resource_conflict')
      ) {
        const conflict = new TransferError(
          'A required chat resource already exists with different data.',
        );

        conflict.code = 'RESOURCE_CONFLICT';

        throw conflict;
      }

      last = err;

      if (err instanceof TransferError && err.code === 'RESOURCE_CONFLICT') {
        throw err;
      }

      if (
        !usesItemCas ||
        !db.isCasConflict(err) ||
        attempt === CAS_ATTEMPTS - 1
      ) {
        throw err;
      }
    }
  }

  throw last;
}

/** Bind a cloned header to the target workspace storage id and URI. */
export function bindWorkspace(
  header: ComposerHeader,
  storageId: string,
  identity: WorkspaceIdentity | undefined,
): ComposerHeader {
  const copy: ComposerHeader = { ...header };
  const uri = identity && identity.uri;

  copy.workspaceIdentifier = {
    id: storageId,
  };

  if (uri) {
    copy.workspaceIdentifier.uri = {
      $mid: 1,
      scheme: uri.scheme,
      authority: uri.authority || '',
      path: uri.path,
      query: uri.query || '',
      fragment: uri.fragment || '',
    };

    if (uri.scheme === 'file') {
      Object.assign(copy.workspaceIdentifier.uri, fileUriMetadata(uri));
    }
  }

  return copy;
}

/** Install resources, commit the global database, then bind the workspace. */
export async function commitImport(opts: {
  /** Transfer context, including cancellation and phase reporting. */
  ctx: TransferContext;
  /** Destination workspace whose databases are written. */
  workspace: WorkspaceEntry;
  /** Open connections and detected layouts for both databases. */
  pair: Awaited<ReturnType<typeof inspectPair>>;
  /** Cloned chats, resources, backups, and pending journal row. */
  prepared: Awaited<ReturnType<typeof prepareImport>>;
  /** Persist journal phase after the global transaction succeeds. */
  onAfterGlobalCommit?: () => Promise<void>;
  /** Persist journal phase after the workspace transaction succeeds. */
  onAfterWorkspaceCommit?: () => Promise<void>;
}): Promise<void> {
  const { ctx, workspace } = opts;
  const { connWs, connGl, wsInfo, glInfo } = opts.pair;

  const { cloned, plansDir, canvasesDir, plan, glBackup, wsBackup } =
    opts.prepared;

  ctx.onPhase?.('write', {
    resources: plan.toWrite.length,
    chats: cloned.allComposers.length,
  });

  for (const resource of plan.plans) {
    await writePlanFile(plansDir, resource);
  }

  if (canvasesDir) {
    for (const resource of plan.canvases) {
      await writeCanvasFile(canvasesDir, resource);
    }
  }

  for (const attachment of plan.attachments) {
    await writeAttachmentFile(workspace, attachment);
  }

  const bound = cloned.allComposers.map((c) =>
    bindWorkspace(c, workspace.storageId, workspace.identity),
  );

  const typedRows = plan.toWrite.map((row) => ({
    key: row.key,
    storageClass: row.value.storageClass,
    bytes: decodeSqliteBytes(row.value),
  }));

  const kvPairs: Array<{ key: string; value: string }> = [];

  for (const [id, value] of Object.entries(cloned.composers)) {
    kvPairs.push({ key: `composerData:${id}`, value });
  }

  for (const list of Object.values(cloned.bubbles || {})) {
    for (const bubble of list || []) {
      kvPairs.push({ key: bubble.key, value: bubble.value });
    }
  }

  const writeGl = connOf(ctx, workspace.globalDbPath, false);

  await commitWithCas(
    ctx,
    writeGl,
    connGl,
    glInfo.layout.itemTable,
    async () => {
      const parts = ['BEGIN IMMEDIATE;'];

      if (typedRows.length) parts.push(db.kvInsertTypedSql(typedRows));
      if (kvPairs.length) parts.push(db.kvInsertSql(kvPairs));

      if (glInfo.layout.composerHeaders) {
        parts.push(
          db.headerUpsertSql(
            bound,
            workspace.storageId,
            glInfo.layout.headerColumns,
          ),
        );
      }

      if (glInfo.layout.itemTable) {
        const raw = await db.reads.readItemText(
          connGl,
          'composer.composerHeaders',
        );

        const blob = parseItemObject(raw);

        parts.push(
          db.itemCasReplaceSql('composer.composerHeaders', raw, {
            ...blob,
            allComposers: mergeComposerList(blob.allComposers, bound),
          }),
        );
      }

      parts.push('COMMIT;');

      return parts.join('\n');
    },
  );

  ctx.onPhase?.('global-commit', { chats: cloned.allComposers.length });
  await opts.onAfterGlobalCommit?.();

  if (wsInfo.layout.itemTable) {
    const writeWs = connOf(ctx, workspace.workspaceDbPath, false);

    try {
      await commitWithCas(ctx, writeWs, connWs, true, async () => {
        const raw = await db.readItemText(connWs, 'composer.composerData');
        const current = parseItemObject(raw);

        const selected = stringList(current.selectedComposerIds);
        const focused = stringList(current.lastFocusedComposerIds);

        for (const c of cloned.allComposers) {
          if (!selected.includes(c.composerId)) selected.push(c.composerId);
          focused.unshift(c.composerId);
        }

        return [
          'BEGIN IMMEDIATE;',
          db.itemCasReplaceSql('composer.composerData', raw, {
            ...current,
            selectedComposerIds: selected,
            lastFocusedComposerIds: focused.slice(0, 10),
            allComposers: mergeComposerList(current.allComposers, bound),
          }),
          'COMMIT;',
        ].join('\n');
      });

      ctx.onPhase?.('workspace-commit');
      await opts.onAfterWorkspaceCommit?.();
    } catch (err) {
      const wrapped = new TransferError(
        err instanceof Error ? err.message : String(err),
      );

      wrapped.code = 'PARTIAL';
      wrapped.backups = { global: glBackup, workspace: wsBackup };

      throw wrapped;
    }
  }
}
