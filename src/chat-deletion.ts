import { lstat } from 'node:fs/promises';
import { MAX_SQLITE_VALUE_BYTES } from './bundle-limits';
import { bubbleRange, sqlText } from './core';
import { inspectDeletionOwnership } from './deletion-ownership';
import {
  checkDeletionTransaction,
  deleteHeaderReferences,
  deleteMessageRows,
} from './deletion-sql';
import type { DeleteResult, DeleteTarget } from './deletion-types';
import { SqliteSession } from './sqlite-session';
import { connOf } from './transfer-context';
import { traceIO, transferEvent } from './transfer-events';
import type { TransferContext, WorkspaceEntry } from './types';

/**
 * Delete confirmed history during an ordinary worker operation. Caller obtains user consent
 * to stop Cursor activity. Transactions protect these writes, not Cursor's in-memory cache.
 * Failures/cancellation return prior committed outcomes; no later workspace is attempted.
 */
export async function deleteSelectedChats(
  /** Transfer hooks, timeouts, and cancellation. */
  ctx: TransferContext,
  /** Workspaces whose chats may be deleted. */
  workspaces: WorkspaceEntry[],
  /** Chats selected for deletion. */
  targets: DeleteTarget[],
): Promise<DeleteResult> {
  const result: DeleteResult = { deleted: [], skipped: [] };
  let commitPending = false;

  try {
    ctx.signal?.throwIfAborted();

    const known = new Map(workspaces.map((w) => [w.workspaceDbPath, w]));

    const normalized = normalizeTargets(targets, known);

    const ownership = await inspectDeletionOwnership(
      ctx,
      workspaces,
      normalized,
    );

    for (const [index, target] of normalized.entries()) {
      ctx.signal?.throwIfAborted();
      const workspace = target.workspace;

      const ids = target.ids.filter((id) => {
        const owners = ownership.owners.get(
          JSON.stringify([workspace.globalDbPath, id]),
        );

        if (owners?.size === 1 && owners.has(workspace.workspaceDbPath))
          return true;

        result.skipped.push(
          `${workspace.workspaceDbPath}: ${id}: shared, absent, or unverified ownership`,
        );

        transferEvent({
          action: 'Retain chat',
          status: 'info',
          path: workspace.workspaceDbPath,
          chatId: id,
          detail: 'Shared, absent, or unverified ownership',
        });

        return false;
      });

      if (ids.length) {
        await validatePaths(workspace);

        await traceIO(
          'Delete workspace history',
          {
            path: workspace.workspaceDbPath,
            detail: `${ids.length} selected chats`,
          },
          async () => {
            const session = await SqliteSession.open({
              ...connOf(ctx, workspace.globalDbPath, false),
              maxLineBytes: 2 * MAX_SQLITE_VALUE_BYTES + 65536,
            });

            try {
              await session.exec(
                `ATTACH DATABASE ${sqlText(workspace.workspaceDbPath)} AS workspace; CREATE TEMP TABLE selected(id TEXT PRIMARY KEY);`,
              );

              for (let start = 0; start < ids.length; start += 64)
                await session.exec(
                  `INSERT INTO selected VALUES ${ids
                    .slice(start, start + 64)
                    .map((id) => `(${sqlText(id)})`)
                    .join(',')};`,
                );
              await session.exec('BEGIN IMMEDIATE;');
              const selected = new Set(ids);

              const layouts = await checkDeletionTransaction(
                ctx,
                workspace,
                session,
                selected,
                ownership.globals.get(workspace.globalDbPath)!,
                ownership.headers.get(workspace.workspaceDbPath)!,
              );

              await deleteHeaderReferences(
                session,
                'main',
                layouts.global,
                selected,
              );

              await deleteHeaderReferences(
                session,
                'workspace',
                layouts.workspace,
                selected,
              );

              await deleteMessageRows(session, ids, ctx.signal);
              ctx.signal?.throwIfAborted();
              commitPending = true;
              await session.exec('COMMIT;');
              commitPending = false;

              for (const id of ids) {
                result.deleted.push(`${workspace.workspaceDbPath}: ${id}`);

                transferEvent({
                  action: 'Delete chat',
                  status: 'completed',
                  path: workspace.workspaceDbPath,
                  chatId: id,
                });
              }
            } finally {
              await session.close();
            }
          },
        );
      }

      ctx.onPhase?.('write', {
        processed: index + 1,
        total: normalized.length,
        unit: 'workspaces',
        chats: result.deleted.length,
      });
    }
  } catch (error) {
    if (commitPending) result.uncertain = true;

    result.cancelled =
      ctx.signal?.aborted ||
      (error instanceof Error && error.name === 'AbortError');

    result.error = error instanceof Error ? error.message : String(error);
  }

  return result;
}

/** Merge duplicate physical selections and validate every ID before any mutation. */
function normalizeTargets(
  /** Chats selected for deletion. */
  targets: DeleteTarget[],
  /** Storage id to the workspace entry. */
  known: Map<string, WorkspaceEntry>,
): DeleteTarget[] {
  const grouped = new Map<
    string,
    {
      /** Physical workspace these chats belong to. */
      workspace: WorkspaceEntry;
      ids: Set<string>;
    }
  >();

  for (const target of targets) {
    const workspace = known.get(target.workspace.workspaceDbPath);

    if (
      !workspace ||
      workspace.globalDbPath !== target.workspace.globalDbPath ||
      workspace.storageId !== target.workspace.storageId
    )
      throw new Error('Workspace storage changed; review the selection again.');

    const group = grouped.get(workspace.workspaceDbPath) || {
      workspace,
      ids: new Set<string>(),
    };

    for (const id of target.ids) {
      bubbleRange(id);
      group.ids.add(id);
    }

    grouped.set(workspace.workspaceDbPath, group);
  }

  return [...grouped.values()].map((group) => ({
    workspace: group.workspace,
    ids: [...group.ids],
  }));
}

/** Reject a missing path or a database file that is itself a symbolic link. */
async function validatePaths(workspace: WorkspaceEntry): Promise<void> {
  if (workspace.globalDbPath === workspace.workspaceDbPath)
    throw new Error('Global and workspace databases must be separate.');

  for (const file of [workspace.globalDbPath, workspace.workspaceDbPath]) {
    // Compare the final path entry only. macOS keeps temp files under /var,
    // which is a symlink to /private/var; that ancestor must not block deletion.
    const info = await lstat(file);

    if (!info.isFile())
      throw new Error(
        'Deletion requires regular database files without symbolic links.',
      );
  }
}
