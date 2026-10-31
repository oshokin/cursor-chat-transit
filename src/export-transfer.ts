import { rm } from 'node:fs/promises';
import path from 'node:path';
import { operationTempDir } from './operation-temp';
import { readBundleObject } from './bundle-object';
import { applyBodyFamily, exportFamilyIds } from './chat-family';
import { selectChats, sqlText } from './core';
import { execSql } from './sqlite';
import * as db from './db';
import { matchesWorkspaceStorage } from './db-headers';
import { exportBundle } from './export-bundle';
import { writeSelectedChats, type ExportAccumulator } from './export-bundle';
import { BundleWriter } from './bundle-writer';
import { connOf, inspectPair } from './transfer-context';
import { openReadTransaction } from './read-transaction';
import type {
  ComposerHeader,
  ExportObject,
  TransferContext,
  WorkspaceEntry,
} from './types';
import { SQLITE_PARAMETER_BATCH_ROWS } from './sqlite-protocol';
import type { ExportSource } from './transfer-process';

/** List composer headers for a workspace without loading bubble bodies. */
export async function listWorkspaceChats(
  /** Transfer hooks, timeouts, and cancellation. */
  ctx: TransferContext,
  workspace: WorkspaceEntry,
  options: {
    /** When true, merge timestamp columns from composerHeaders into listed headers. */
    includeColumnDates?: boolean;
    /** Read views owned by the export, when resolving headers for an archive. */
    connections?: {
      /** Workspace header view, released after catalogue resolution. */
      connWs: import('./types').SqliteConn;
      /** Global view shared by headers, bodies, messages and dependencies. */
      connGl: import('./types').SqliteConn;
    };
  } = {},
): Promise<{
  /** Merged composer headers visible in this workspace. */
  allComposers: ComposerHeader[];
  /** Provenance recorded for a later export. */
  source: NonNullable<ExportObject['source']>;
}> {
  const pair = options.connections;

  const { connWs, connGl, wsInfo, glInfo } = pair
    ? {
        ...pair,
        wsInfo: await db.inspectDatabase(pair.connWs),
        glInfo: await db.inspectDatabase(pair.connGl),
      }
    : await inspectPair(ctx, workspace);

  if (glInfo.layout.writeBlocked && !glInfo.layout.cursorDiskKV) {
    throw new Error(
      glInfo.layout.unsupportedReason || 'Unsupported Cursor database schema.',
    );
  }

  const allComposers = await mergeBodyFamily(
    connGl,
    await db.resolveComposers(connWs, connGl, {
      storageId: workspace.storageId,
      identity: workspace.identity,
      layoutWs: wsInfo.layout,
      layoutGl: glInfo.layout,
      includeColumnDates: options.includeColumnDates,
    }),
  );

  return {
    allComposers,
    source: {
      schema: glInfo.layout.composerHeaders ? 'header-table' : 'legacy',
      workspace: workspace.identity || {
        kind: 'folder',
        uri: { path: workspace.storageId },
      },
    },
  };
}

/** Copy family links that live only on composer bodies. Header links win when both exist. */
export async function mergeBodyFamily(
  conn: import('./types').SqliteConn,
  headers: ComposerHeader[],
): Promise<ComposerHeader[]> {
  if (!headers.length) return headers;

  const links = new Map<
    string,
    {
      parent?: string;
      root?: string;
      children?: string[];
      isSubagent?: boolean;
    }
  >();

  try {
    for (
      let start = 0;
      start < headers.length;
      start += SQLITE_PARAMETER_BATCH_ROWS
    ) {
      const batch = headers.slice(start, start + SQLITE_PARAMETER_BATCH_ROWS);

      const rows = (
        await execSql({
          ...conn,
          readOnly: true,
          sql: `SELECT substr(key,14), CASE WHEN json_valid(value) THEN json_extract(value,'$.subagentInfo.parentComposerId') END, CASE WHEN json_valid(value) THEN json_extract(value,'$.subagentInfo.rootParentConversationId') END, CASE WHEN json_valid(value) THEN json_extract(value,'$.subagentComposerIds') END, CASE WHEN json_valid(value) THEN json_extract(value,'$.isSubagent') END FROM cursorDiskKV WHERE key IN (${batch.map((header) => sqlText(`composerData:${header.composerId}`)).join(',')});`,
        })
      ).trim();

      if (!rows) continue;

      for (const line of rows.split('\n')) {
        const [id, parent, root, children, flag] = line.split('\t');

        if (!id) continue;
        let parsed: string[] | undefined;

        if (children) {
          try {
            const value = JSON.parse(children) as unknown;

            if (Array.isArray(value))
              parsed = value.filter(
                (item): item is string => typeof item === 'string',
              );
          } catch {
            parsed = undefined;
          }
        }

        links.set(id, {
          parent: parent || undefined,
          root: root || undefined,
          children: parsed,
          isSubagent: flag === '1' || flag === 'true',
        });
      }
    }
  } catch {
    return headers;
  }

  return headers.map((header) =>
    applyBodyFamily(header, links.get(header.composerId) || {}),
  );
}

/** Write one archive from checked scopes in a single Cursor profile. */
export async function exportManyToFile(
  ctx: TransferContext,
  sources: readonly ExportSource[],
  destPath: string,
): Promise<
  { skipped: true; reason: string } | NonNullable<ExportObject['summary']>
> {
  if (!sources.length) return { skipped: true, reason: 'empty-selection' };

  const normalizeDatabase = (database: string) => {
    const resolved = path.resolve(database);

    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };

  const globalPath = normalizeDatabase(sources[0].workspace.globalDbPath);

  if (
    sources.some(
      (source) =>
        normalizeDatabase(source.workspace.globalDbPath) !== globalPath,
    )
  ) {
    throw new Error(
      'Selected workspaces belong to different Cursor profiles and cannot share one export.',
    );
  }

  const global = await openReadTransaction(
    connOf(ctx, sources[0].workspace.globalDbPath, true),
  );

  const groups: Array<{
    workspace: WorkspaceEntry;
    selected: ComposerHeader[];
  }> = [];

  const claimed = new Map<
    string,
    { workspace: WorkspaceEntry; header: ComposerHeader; explicit: boolean }
  >();

  const requested = new Set<string>();
  const unresolved = new Set<string>();

  try {
    for (const source of sources) {
      ctx.signal?.throwIfAborted();

      const local = await openReadTransaction(
        connOf(ctx, source.workspace.workspaceDbPath, true),
      );

      try {
        const listed = await listWorkspaceChats(ctx, source.workspace, {
          connections: { connGl: global.conn, connWs: local.conn },
        });

        const family = exportFamilyIds(listed.allComposers, source.selectedIds);
        const ids = new Set(family.ids);

        const wanted =
          source.selectedIds ??
          listed.allComposers.map((header) => header.composerId);

        for (const id of wanted) {
          requested.add(id);
          if (!ids.has(id)) unresolved.add(id);
        }

        for (const header of selectChats(listed.allComposers, family.ids)) {
          const existing = claimed.get(header.composerId);
          const explicitId = header.workspaceIdentifier?.id;
          const explicit = explicitId === source.workspace.storageId;

          if (
            typeof explicitId === 'string' &&
            explicitId.length > 0 &&
            !explicit
          ) {
            throw new Error(
              `Chat ${header.composerId} belongs to another workspace storage.`,
            );
          }

          if (
            header.workspaceIdentifier &&
            !matchesWorkspaceStorage(
              header,
              source.workspace.storageId,
              source.workspace.identity,
            )
          ) {
            throw new Error(
              `Chat ${header.composerId} has an ambiguous workspace binding.`,
            );
          }

          if (!existing) {
            claimed.set(header.composerId, {
              workspace: source.workspace,
              header,
              explicit,
            });
          } else if (explicit && !existing.explicit) {
            claimed.set(header.composerId, {
              workspace: source.workspace,
              header,
              explicit,
            });
          } else if (
            explicit &&
            existing.explicit &&
            existing.workspace.storageId !== source.workspace.storageId
          ) {
            throw new Error(
              `Chat ${header.composerId} has conflicting explicit workspace bindings.`,
            );
          } else if (
            !explicit &&
            !existing.explicit &&
            existing.workspace.storageId !== source.workspace.storageId
          ) {
            throw new Error(
              `Chat ${header.composerId} has ambiguous workspace ownership.`,
            );
          }
        }
      } finally {
        await local.close();
      }
    }

    if (!claimed.size) {
      await global.close();

      return {
        skipped: true,
        reason: unresolved.size ? 'unresolved-family' : 'empty-selection',
      };
    }

    for (const source of sources) {
      const selected = [...claimed.values()]
        .filter(
          (entry) =>
            entry.workspace.storageId === source.workspace.storageId &&
            entry.workspace.storageRoot === source.workspace.storageRoot,
        )
        .map((entry) => entry.header);

      if (selected.length)
        groups.push({ workspace: source.workspace, selected });
    }

    const writer = await BundleWriter.open(destPath, {
      signal: ctx.signal,
      source: {
        schema: 'multi-workspace',
        workspaceCount: groups.length,
      },
      maxJsonProperties: ctx.maxJsonProperties,
    });

    const tmp = await operationTempDir('cct-export-', ctx.temporaryDirectory);

    const accumulator: ExportAccumulator = {
      issues: [],
      incomplete: [...unresolved],
      bubbles: 0,
      exported: 0,
      recoveryCandidates: 0,
    };

    const total = claimed.size;
    let offset = 0;

    try {
      for (const group of groups) {
        await writeSelectedChats({
          ctx,
          workspace: group.workspace,
          conn: global.conn,
          selected: group.selected,
          writer,
          tmp,
          accumulator,
          chatOffset: offset,
          chatTotal: total,
        });

        offset += group.selected.length;
      }

      await global.close();

      const summary: NonNullable<ExportObject['summary']> = {
        complete:
          accumulator.incomplete.length === 0 &&
          accumulator.issues.length === 0,
        incomplete: accumulator.incomplete,
        selected: total,
        exported: accumulator.exported,
        issues: accumulator.issues,
      };

      ctx.onPhase?.('write', {
        chats: accumulator.exported,
        bubbles: accumulator.bubbles,
      });

      await writer.finish(summary);

      return summary;
    } catch (error) {
      await writer.abort();

      throw error;
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  } finally {
    await global.close().catch(() => undefined);
  }
}

/** Build an export object for a workspace; missing bodies are listed as incomplete. */
export async function buildExportObject(
  /** Transfer hooks, timeouts, and cancellation. */
  ctx: TransferContext,
  workspace: WorkspaceEntry,
  /** Composer ids to keep. An empty list keeps none. */
  selectedIds?: string[],
): Promise<ExportObject> {
  const dir = await operationTempDir('cct-object-', ctx.temporaryDirectory);
  const dest = path.join(dir, 'export.cursor-chat.zip');

  try {
    const summary = await exportToFile(ctx, workspace, dest, selectedIds);
    const obj = await readBundleObject(dest);

    if (summary && !('skipped' in summary)) obj.summary = summary;

    return obj;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Write an export file, or skip when the selection is empty. */
export async function exportToFile(
  /** Transfer hooks, timeouts, and cancellation. */
  ctx: TransferContext,
  /** Workspace whose chats are exported. */
  workspace: WorkspaceEntry,
  /** Destination archive path. */
  destPath: string,
  /** Chat ids to export. Omit to export every listed chat. */
  selectedIds?: string[],
  /** When true, count recoverable chats and skip compression when none exist. */
  assessRecovery = false,
): Promise<
  | {
      /** True when the user cancelled or there was nothing to write. */
      skipped: true;
      /** Why no file was written. */
      reason: string;
    }
  | NonNullable<ExportObject['summary']>
> {
  if (selectedIds && selectedIds.length === 0) {
    return { skipped: true, reason: 'empty-selection' };
  }

  const global = await openReadTransaction(
    connOf(ctx, workspace.globalDbPath, true),
  );

  let local: Awaited<ReturnType<typeof openReadTransaction>> | undefined;

  try {
    local = await openReadTransaction(
      connOf(ctx, workspace.workspaceDbPath, true),
    );

    const listed = await listWorkspaceChats(ctx, workspace, {
      connections: { connGl: global.conn, connWs: local.conn },
    });

    await local.close();
    const family = exportFamilyIds(listed.allComposers, selectedIds);

    if (!family.ids.length)
      return {
        skipped: true,
        reason: family.diagnostics.length
          ? 'unresolved-family'
          : 'empty-selection',
      };

    const selected = selectChats(listed.allComposers, family.ids);

    ctx.onPhase?.('selection', { chats: selected.length });

    const summary = await exportBundle({
      ctx,
      workspace,
      conn: global.conn,
      destPath,
      selected,
      source: listed.source,
      readComplete: global.close,
      assessRecovery,
    });

    if (!('skipped' in summary)) {
      const affected = new Set(summary.incomplete);

      const requested =
        selectedIds ?? listed.allComposers.map((header) => header.composerId);

      for (const id of requested)
        if (!family.ids.includes(id)) affected.add(id);

      for (const item of family.diagnostics)
        if (family.ids.includes(item.composerId)) affected.add(item.composerId);

      if (affected.size) {
        summary.incomplete = [...affected];
        summary.complete = false;
      }
    }

    return summary;
  } finally {
    try {
      await local?.close();
    } finally {
      await global.close();
    }
  }
}
