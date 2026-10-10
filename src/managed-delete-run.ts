import { lstat, realpath } from 'node:fs/promises';
import { bubbleRange } from './core';
import { deleteSelectedChats } from './chat-deletion';
import { inspectDeletionOwnership } from './deletion-ownership';
import type {
  DeletionJob,
  ManagedDeleteOutcome,
  ManagedDeleteResult,
  ManagedPlanTarget,
  ManagedPrepareResult,
} from './deletion-types';
import { planTargetMatches } from './managed-delete-plan';
import { workspacePresentation } from './workspace-presentation';
import { WorkspaceHeaderReader } from './workspace-header-reader';
import {
  databaseToken,
  resolveWorkspaceDirectory,
  removeWorkspaceDirectory,
  workspaceDataRefusal,
} from './workspace-removal';
import { transferEvent } from './transfer-events';
import type { TransferContext, WorkspaceEntry } from './types';

/** Composer ids reported by chat deletion for one database path. */
function idsFrom(lines: string[], database: string): string[] {
  const prefix = `${database}: `;

  return lines.flatMap((line) => {
    if (!line.startsWith(prefix)) return [];
    const id = line.slice(prefix.length).split(': ')[0];

    return id ? [id] : [];
  });
}

/** Inventory entry that still matches the request's physical pair. */
function sameEntry(
  workspaces: WorkspaceEntry[],
  entry: WorkspaceEntry,
): WorkspaceEntry {
  const found = workspaces.find(
    (workspace) => workspace.workspaceDbPath === entry.workspaceDbPath,
  );

  if (
    !found ||
    found.globalDbPath !== entry.globalDbPath ||
    found.storageId !== entry.storageId ||
    found.storageRoot !== entry.storageRoot
  )
    throw new Error('Workspace storage changed; review the selection again.');

  return found;
}

/** Refusal when this window is the one using the candidate, after realpath. */
async function activeRefusal(
  entry: WorkspaceEntry,
  current: {
    /** Open window database, when known. */
    database?: string;
    /** Open window identity, when the database path is unknown. */
    identity?: WorkspaceEntry['identity'];
    /** True for an empty window. */
    emptyWindow: boolean;
  },
): Promise<string | undefined> {
  let database: string | undefined;
  let target: string | undefined;

  try {
    if (current.database) database = await realpath(current.database);
  } catch {
    database = undefined;
  }

  try {
    target = await realpath(entry.workspaceDbPath);
  } catch {
    target = undefined;
  }

  return workspaceDataRefusal(entry, current, { database, target });
}

/** True for a missing path. Node exposes this on the filesystem error. */
function missingPath(cause: unknown): boolean {
  return (
    typeof cause === 'object' &&
    cause !== null &&
    'code' in cause &&
    cause.code === 'ENOENT'
  );
}

/** Exclusive ownership of every id. Missing ownership is not exclusive. */
function exclusivelyOwned(
  owners: Map<string, Set<string>>,
  entry: WorkspaceEntry,
  ids: string[],
): boolean {
  return ids.every((id) => {
    const set = owners.get(JSON.stringify([entry.globalDbPath, id]));

    return set?.size === 1 && set.has(entry.workspaceDbPath);
  });
}

/** Blank outcome for a target that must not be described as deleted. */
function untouched(
  target: ManagedPlanTarget,
  storage: ManagedDeleteOutcome['storage'],
  errorMessage?: string,
): ManagedDeleteOutcome {
  return {
    kind: target.kind,
    workspaceKey: target.workspace.workspaceDbPath,
    label: target.name,
    chatIdsDeleted: [],
    chatIdsSkipped: [],
    storage:
      target.kind === 'chats' && storage === 'deleted'
        ? 'not-requested'
        : storage,
    errorMessage,
  };
}

/**
 * Read ownership and paths, then close every reader before returning.
 * A refusal covers the whole request: nothing is deleted.
 */
export async function prepareManagedDelete(
  /** Transfer hooks, timeouts, and cancellation. */
  ctx: TransferContext,
  /** Prepare job without the kind tag. */
  job: Extract<DeletionJob, { kind: 'prepare-managed-delete' }>,
): Promise<ManagedPrepareResult> {
  const targets: ManagedPlanTarget[] = [];
  const reader = new WorkspaceHeaderReader(ctx);

  for (const request of job.requests) {
    ctx.signal?.throwIfAborted();
    const entry = sameEntry(job.workspaces, request.workspace);
    const presentation = workspacePresentation(entry);

    if (request.kind === 'workspace-data') {
      const refusal = await activeRefusal(entry, job);

      if (refusal)
        return {
          ok: false,
          title: 'Cannot delete the selected data',
          detail: `${refusal}\nNo data was deleted.`,
        };

      try {
        await resolveWorkspaceDirectory(job.userDataRoot, entry);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        return {
          ok: false,
          title: 'Cannot delete the selected data',
          detail: `“${presentation.name}” cannot be deleted: ${message} No data was deleted.`,
        };
      }

      let ids: string[];

      try {
        ids = [
          ...new Set(
            (await reader.read(entry, true)).map((row) => row.composerId),
          ),
        ];
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        return {
          ok: false,
          title: 'Cannot delete the selected data',
          detail: `“${presentation.name}” uses an unsupported or unreadable database: ${message} No data was deleted.`,
        };
      }

      if (ids.length) {
        const ownership = await inspectDeletionOwnership(ctx, job.workspaces, [
          { workspace: entry, ids },
        ]);

        if (!exclusivelyOwned(ownership.owners, entry, ids))
          return {
            ok: false,
            title: 'Cannot delete the selected data',
            detail: `“${presentation.name}” contains chat history also referenced by another workspace.\nNo data was deleted. Clear this workspace from the selection and try again.`,
          };
      }

      targets.push({
        kind: 'workspace-data',
        workspace: entry,
        ids,
        token: await databaseToken(entry.workspaceDbPath),
        name: presentation.name,
        location: presentation.location,
        pathLabel: presentation.path,
      });

      continue;
    }

    const ids = [...new Set(request.ids)];

    for (const id of ids) bubbleRange(id);

    targets.push({
      kind: 'chats',
      workspace: entry,
      ids,
      token: await databaseToken(entry.workspaceDbPath),
      name: presentation.name,
      location: presentation.location,
      pathLabel: presentation.path,
    });
  }

  transferEvent({
    action: 'Workspace deletion prepared',
    status: 'info',
    detail: `${targets.length} targets`,
  });

  return { ok: true, plan: { userDataRoot: job.userDataRoot, targets } };
}

/**
 * Re-check the confirmed plan, delete exclusive history, then remove workspace directories.
 * SQLite and the filesystem are not one transaction. Earlier targets stay deleted.
 */
export async function executeManagedDelete(
  /** Transfer hooks, timeouts, and cancellation. */
  ctx: TransferContext,
  /** Execute job without the kind tag. */
  job: Extract<DeletionJob, { kind: 'delete-managed-data' }>,
): Promise<ManagedDeleteResult> {
  const outcomes: ManagedDeleteOutcome[] = [];
  let cancelled = false;
  let uncertain = false;
  let error: string | undefined;

  /** Record every target not yet started and stop the loop. */
  const stopAt = (index: number, message?: string) => {
    error = message || error;

    for (const target of job.plan.targets.slice(index))
      outcomes.push(untouched(target, 'not-started', message));
  };

  for (const [index, target] of job.plan.targets.entries()) {
    if (ctx.signal?.aborted) {
      cancelled = true;
      stopAt(index, 'Deletion cancelled.');
      break;
    }

    try {
      const entry = sameEntry(job.workspaces, target.workspace);

      if (entry.storageRoot !== job.plan.userDataRoot)
        throw new Error(
          'The user-data directory changed. Review the selection again.',
        );
      let token: string;

      try {
        token = await databaseToken(entry.workspaceDbPath);
      } catch (cause) {
        if (target.kind === 'workspace-data' && missingPath(cause)) {
          outcomes.push(
            untouched(target, 'unknown', 'Workspace data was already gone.'),
          );

          continue;
        }

        throw cause;
      }

      if (target.kind === 'chats') {
        if (token !== target.token)
          throw new Error(
            'Selected chats changed during confirmation. Review the selection again.',
          );

        const deleted = await deleteSelectedChats(ctx, job.workspaces, [
          { workspace: entry, ids: target.ids },
        ]);

        outcomes.push({
          kind: 'chats',
          workspaceKey: entry.workspaceDbPath,
          label: target.name,
          chatIdsDeleted: idsFrom(deleted.deleted, entry.workspaceDbPath),
          chatIdsSkipped: idsFrom(deleted.skipped, entry.workspaceDbPath),
          storage: 'not-requested',
          errorMessage: deleted.error,
        });

        uncertain ||= deleted.uncertain === true;
        cancelled ||= deleted.cancelled === true;

        if (deleted.uncertain || deleted.cancelled || deleted.error) {
          stopAt(index + 1, deleted.error);
          break;
        }

        continue;
      }

      const refusal = await activeRefusal(entry, job);

      if (refusal) throw new Error(refusal);
      let directory: string;

      try {
        directory = await resolveWorkspaceDirectory(
          job.plan.userDataRoot,
          entry,
        );
      } catch (cause) {
        if (missingPath(cause)) {
          outcomes.push(
            untouched(target, 'unknown', 'Workspace data was already gone.'),
          );

          continue;
        }

        throw cause;
      }

      const ids = [
        ...new Set(
          (await new WorkspaceHeaderReader(ctx).read(entry, true)).map(
            (row) => row.composerId,
          ),
        ),
      ];

      if (!planTargetMatches(target, ids, token))
        throw new Error(
          'Workspace history changed during confirmation. Review the selection again.',
        );

      if (ids.length) {
        const ownership = await inspectDeletionOwnership(ctx, job.workspaces, [
          { workspace: entry, ids },
        ]);

        if (!exclusivelyOwned(ownership.owners, entry, ids))
          throw new Error(
            `“${target.name}” contains chat history also referenced by another workspace.`,
          );
      }

      let chatIdsDeleted: string[] = [];

      if (ids.length) {
        const deleted = await deleteSelectedChats(ctx, job.workspaces, [
          { workspace: entry, ids },
        ]);

        chatIdsDeleted = idsFrom(deleted.deleted, entry.workspaceDbPath);
        uncertain ||= deleted.uncertain === true;

        if (
          deleted.uncertain ||
          deleted.cancelled ||
          deleted.error ||
          deleted.skipped.length
        ) {
          outcomes.push({
            kind: 'workspace-data',
            workspaceKey: entry.workspaceDbPath,
            label: target.name,
            chatIdsDeleted,
            chatIdsSkipped: idsFrom(deleted.skipped, entry.workspaceDbPath),
            storage: 'not-started',
            errorMessage:
              deleted.error ||
              'Ownership changed before workspace data could be removed.',
          });

          cancelled ||= deleted.cancelled === true;
          stopAt(index + 1, deleted.error);
          break;
        }
      }

      if (ctx.signal?.aborted) {
        outcomes.push({
          kind: 'workspace-data',
          workspaceKey: entry.workspaceDbPath,
          label: target.name,
          chatIdsDeleted,
          chatIdsSkipped: [],
          storage: 'not-started',
          errorMessage: 'Deletion cancelled after chat history was deleted.',
        });

        cancelled = true;
        stopAt(index + 1, 'Deletion cancelled.');
        break;
      }

      transferEvent({
        action: 'Remove workspace data started',
        status: 'info',
        path: directory,
      });

      try {
        await removeWorkspaceDirectory(directory);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);

        outcomes.push({
          kind: 'workspace-data',
          workspaceKey: entry.workspaceDbPath,
          label: target.name,
          chatIdsDeleted,
          chatIdsSkipped: [],
          storage: 'partial',
          errorCode:
            typeof cause === 'object' && cause !== null && 'code' in cause
              ? String(cause.code)
              : undefined,
          errorMessage: message,
        });

        stopAt(index + 1, message);
        break;
      }

      try {
        await lstat(directory);

        outcomes.push({
          kind: 'workspace-data',
          workspaceKey: entry.workspaceDbPath,
          label: target.name,
          chatIdsDeleted,
          chatIdsSkipped: [],
          storage: 'partial',
          errorMessage: 'Workspace data directory is still present.',
        });

        stopAt(index + 1, 'Workspace data directory is still present.');
        break;
      } catch (cause) {
        const code =
          typeof cause === 'object' && cause !== null && 'code' in cause
            ? cause.code
            : undefined;

        if (code !== 'ENOENT') throw cause;
      }

      transferEvent({
        action: 'Remove workspace data completed',
        status: 'completed',
        path: directory,
      });

      outcomes.push({
        kind: 'workspace-data',
        workspaceKey: entry.workspaceDbPath,
        label: target.name,
        chatIdsDeleted,
        chatIdsSkipped: [],
        storage: 'deleted',
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);

      outcomes.push(untouched(target, 'not-started', message));
      stopAt(index + 1, message);
      break;
    }
  }

  return { outcomes, cancelled, uncertain, error };
}
