import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { bubbleRange, sqlText } from './core';
import { deleteSelectedChats } from './chat-deletion';
import { inspectDeletionOwnership } from './deletion-ownership';
import type {
  DeletionJob,
  EmptyWorkspaceScan,
  ManagedDeleteOutcome,
  ManagedDeleteResult,
  ManagedPlanTarget,
  ManagedPrepareResult,
} from './deletion-types';
import { workspacePresentation } from './workspace-presentation';
import { assessWorkspaceHistory } from './workspace-history';
import { WorkspaceHeaderReader } from './workspace-header-reader';
import { foreignImageRefusal } from './workspace-resources';
import {
  databaseToken,
  directoryIdentity,
  sameDatabaseToken,
  resolveWorkspaceDirectory,
  removeWorkspaceDirectory,
  workspaceDataRefusal,
} from './workspace-removal';
import { execSql, execSqlHexRows } from './sqlite';
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

      let directory: string;

      try {
        directory = await resolveWorkspaceDirectory(job.userDataRoot, entry);
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

      const imageRefusal = await foreignImageRefusal(ctx, entry, ids);

      if (imageRefusal)
        return {
          ok: false,
          title: 'Cannot delete the selected data',
          detail: `“${presentation.name}” cannot be deleted: ${imageRefusal}`,
        };

      if (request.requireEmpty) {
        const state = await assessWorkspaceHistory(ctx, entry);

        if (state.state !== 'empty')
          return {
            ok: false,
            title: 'Cannot delete the selected data',
            detail:
              'Some selected workspaces are no longer empty. Nothing was deleted. Review the selection and try again.',
          };
      }

      targets.push({
        kind: 'workspace-data',
        workspace: entry,
        ids,
        token: await databaseToken(entry.workspaceDbPath),
        directoryId: await directoryIdentity(directory),
        requireEmpty: request.requireEmpty ? true : undefined,
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

  const owned = targets.filter(
    (target) => target.kind === 'workspace-data' && target.ids.length,
  );

  if (owned.length) {
    const ownership = await inspectDeletionOwnership(
      ctx,
      job.workspaces,
      owned.map((target) => ({ workspace: target.workspace, ids: target.ids })),
    );

    for (const target of owned)
      if (!exclusivelyOwned(ownership.owners, target.workspace, target.ids))
        return {
          ok: false,
          title: 'Cannot delete the selected data',
          detail: `“${target.name}” contains chat history also referenced by another workspace.\nNo data was deleted. Clear this workspace from the selection and try again.`,
        };
  }

  // Ownership reads can create or remove a WAL after the first stat.
  // Sample every database once those readers have returned.
  for (const target of targets)
    target.token = await databaseToken(target.workspace.workspaceDbPath);

  const globalTokens: Record<string, string> = {};

  for (const target of targets) {
    const database = target.workspace.globalDbPath;

    if (globalTokens[database]) continue;
    globalTokens[database] = await databaseToken(database);
  }

  for (const target of targets) {
    if (!target.ids.length) continue;

    target.chatFingerprint = await chatSelectionFingerprint(
      ctx,
      target.workspace.globalDbPath,
      target.ids,
    );
  }

  transferEvent({
    action: 'Workspace deletion prepared',
    status: 'info',
    detail: `${targets.length} targets`,
  });

  return {
    ok: true,
    plan: { userDataRoot: job.userDataRoot, targets, globalTokens },
  };
}

/**
 * Re-check the confirmed plan, delete exclusive history, then remove workspace directories.
 * SQLite and the filesystem are not one transaction. Earlier targets stay deleted.
 * Ownership is read once per phase. Directories this operation already removed are not opened again.
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
  const removed = new Set<string>();
  const acceptedGlobal = { ...(job.plan.globalTokens ?? {}) };
  const finished = new Set<string>();
  const quiet: TransferContext = { ...ctx, onPhase: undefined };

  let ownership:
    Awaited<ReturnType<typeof inspectDeletionOwnership>> | undefined;

  /** Batch progress. Nested chat deletion does not publish its own 1/1. */
  const report = () => {
    ctx.onPhase?.('write', {
      processed: outcomes.length,
      total: job.plan.targets.length,
      chats: outcomes.reduce(
        (sum, outcome) => sum + outcome.chatIdsDeleted.length,
        0,
      ),
      unit: 'workspaces',
    });
  };

  /** Record every target not yet started and stop the loop. */
  const stopAt = (index: number, message?: string) => {
    error = message || error;

    for (const target of job.plan.targets.slice(index))
      outcomes.push(untouched(target, 'not-started', message));
    report();
  };

  /** True until this operation has committed a delete or removed a directory. */
  const beforeAnyWrite = () =>
    !outcomes.some(
      (outcome) =>
        outcome.chatIdsDeleted.length > 0 ||
        outcome.storage === 'deleted' ||
        outcome.storage === 'partial',
    );

  /** Global database identity. Own writes update `acceptedGlobal`; external writes do not. */
  const assertGlobals = async () => {
    const emptySelection = job.plan.targets.every(
      (target) => target.requireEmpty,
    );

    for (const [database, token] of Object.entries(acceptedGlobal)) {
      const now = await databaseToken(database);

      if (sameDatabaseToken(token, now)) continue;

      // Cursor rewrites globalStorage while the confirmation dialog is open.
      // The file clock is not the selected chat. Compare those rows instead.
      const pending = job.plan.targets.filter(
        (target) =>
          target.workspace.globalDbPath === database &&
          !finished.has(target.workspace.workspaceDbPath) &&
          target.ids.length > 0,
      );

      let unchanged =
        emptySelection ||
        pending.every((target) => target.chatFingerprint !== undefined);

      if (unchanged && !emptySelection) {
        for (const target of pending) {
          const live = await chatSelectionFingerprint(
            ctx,
            database,
            target.ids,
          );

          if (live !== target.chatFingerprint) {
            unchanged = false;
            break;
          }
        }
      }

      if (unchanged) {
        acceptedGlobal[database] = now;
        continue;
      }

      throw new Error(
        'Workspace history changed during confirmation. Review the selection again.',
      );
    }
  };

  /** A database this operation did not remove must still be readable. */
  const assertInventory = async () => {
    for (const workspace of job.workspaces) {
      if (removed.has(workspace.workspaceDbPath)) continue;

      try {
        await lstat(workspace.workspaceDbPath);
      } catch (cause) {
        if (!missingPath(cause)) throw cause;

        const planned = job.plan.targets.some(
          (target) =>
            target.workspace.workspaceDbPath === workspace.workspaceDbPath,
        );

        // A selected directory that is already gone is reported per target.
        // A different missing database still blocks the batch.
        if (!planned)
          throw new Error('A workspace database disappeared during deletion.', {
            cause,
          });
      }
    }
  };

  /** Re-read one target. `gone` is an already-missing directory, not a deletion we performed. */
  const readTarget = async (target: ManagedPlanTarget) => {
    const entry = sameEntry(job.workspaces, target.workspace);

    if (entry.storageRoot !== job.plan.userDataRoot)
      throw new Error(
        'The user-data directory changed. Review the selection again.',
      );

    try {
      await databaseToken(entry.workspaceDbPath);
    } catch (cause) {
      if (target.kind === 'workspace-data' && missingPath(cause))
        return { gone: true as const, entry };

      throw cause;
    }

    if (target.kind === 'chats')
      return {
        gone: false as const,
        entry,
        ids: target.ids,
        directory: undefined,
      };

    const refusal = await activeRefusal(entry, job);

    if (refusal) throw new Error(refusal);

    let directory: string;

    try {
      directory = await resolveWorkspaceDirectory(job.plan.userDataRoot, entry);
    } catch (cause) {
      if (missingPath(cause)) return { gone: true as const, entry };

      throw cause;
    }

    if (
      target.directoryId &&
      (await directoryIdentity(directory)) !== target.directoryId
    )
      throw new Error(
        'Workspace storage changed during confirmation. Review the selection again.',
      );

    const ids = [
      ...new Set(
        (await new WorkspaceHeaderReader(ctx).read(entry, true)).map(
          (row) => row.composerId,
        ),
      ),
    ];

    const sameIds =
      [...target.ids].sort().join('\n') === [...ids].sort().join('\n');

    // Editor state rewrites the workspace file without changing the chat index.
    if (!sameIds)
      throw new Error(
        target.requireEmpty && beforeAnyWrite()
          ? 'Some selected workspaces are no longer empty. Nothing was deleted. Review the selection and try again.'
          : 'Workspace history changed during confirmation. Review the selection again.',
      );

    if (target.requireEmpty) {
      const history = await assessWorkspaceHistory(ctx, entry);

      if (history.state !== 'empty')
        throw new Error(
          beforeAnyWrite()
            ? 'Some selected workspaces are no longer empty. Nothing was deleted. Review the selection and try again.'
            : 'Workspace history changed during confirmation. Review the selection again.',
        );
    }

    const imageRefusal = await foreignImageRefusal(ctx, entry, ids);

    if (imageRefusal) throw new Error(imageRefusal);

    return { gone: false as const, entry, ids, directory };
  };

  if (ctx.signal?.aborted) {
    for (const target of job.plan.targets)
      outcomes.push(untouched(target, 'not-started', 'Deletion cancelled.'));
    report();

    return { outcomes, cancelled: true, error: 'Deletion cancelled.' };
  }

  try {
    await assertGlobals();
    await assertInventory();

    const pending: Array<{ workspace: WorkspaceEntry; ids: string[] }> = [];

    for (const target of job.plan.targets) {
      const read = await readTarget(target);

      if (!read.gone && read.ids.length)
        pending.push({ workspace: read.entry, ids: read.ids });
    }

    if (pending.length) {
      ownership = await inspectDeletionOwnership(ctx, job.workspaces, pending);

      for (const target of pending)
        if (!exclusivelyOwned(ownership.owners, target.workspace, target.ids))
          throw new Error(
            'A selected workspace contains chat history also referenced by another workspace.',
          );
    }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);

    const aborted =
      ctx.signal?.aborted === true ||
      (cause instanceof Error && cause.name === 'AbortError');

    for (const target of job.plan.targets)
      outcomes.push(
        untouched(
          target,
          'not-started',
          aborted ? 'Deletion cancelled.' : message,
        ),
      );
    report();

    return {
      outcomes,
      cancelled: aborted,
      error: aborted ? 'Deletion cancelled.' : message,
    };
  }

  for (const [index, target] of job.plan.targets.entries()) {
    if (ctx.signal?.aborted) {
      cancelled = true;
      stopAt(index, 'Deletion cancelled.');
      break;
    }

    let committed: string[] = [];
    let recorded = false;

    try {
      await assertGlobals();
      await assertInventory();
      const read = await readTarget(target);

      if (read.gone) {
        outcomes.push(
          untouched(target, 'unknown', 'Workspace data was already gone.'),
        );

        report();
        continue;
      }

      const live = job.workspaces.filter(
        (workspace) => !removed.has(workspace.workspaceDbPath),
      );

      if (target.kind === 'chats') {
        const deleted = await deleteSelectedChats(
          quiet,
          live,
          [{ workspace: read.entry, ids: target.ids }],
          ownership,
        );

        outcomes.push({
          kind: 'chats',
          workspaceKey: read.entry.workspaceDbPath,
          label: target.name,
          chatIdsDeleted: idsFrom(deleted.deleted, read.entry.workspaceDbPath),
          chatIdsSkipped: idsFrom(deleted.skipped, read.entry.workspaceDbPath),
          storage: 'not-requested',
          errorMessage: deleted.error,
        });

        recorded = true;
        report();
        uncertain ||= deleted.uncertain === true;
        cancelled ||= deleted.cancelled === true;

        if (deleted.uncertain || deleted.cancelled || deleted.error) {
          stopAt(index + 1, deleted.error);
          break;
        }

        finished.add(read.entry.workspaceDbPath);

        acceptedGlobal[read.entry.globalDbPath] = await databaseToken(
          read.entry.globalDbPath,
        );

        continue;
      }

      if (
        read.ids.length &&
        ownership &&
        !exclusivelyOwned(ownership.owners, read.entry, read.ids)
      )
        throw new Error(
          `“${target.name}” contains chat history also referenced by another workspace.`,
        );

      if (read.ids.length) {
        const deleted = await deleteSelectedChats(
          quiet,
          live,
          [{ workspace: read.entry, ids: read.ids }],
          ownership,
        );

        committed = idsFrom(deleted.deleted, read.entry.workspaceDbPath);
        uncertain ||= deleted.uncertain === true;

        if (
          deleted.uncertain ||
          deleted.cancelled ||
          deleted.error ||
          deleted.skipped.length
        ) {
          outcomes.push({
            kind: 'workspace-data',
            workspaceKey: read.entry.workspaceDbPath,
            label: target.name,
            chatIdsDeleted: committed,
            chatIdsSkipped: idsFrom(
              deleted.skipped,
              read.entry.workspaceDbPath,
            ),
            storage: deleted.cancelled
              ? 'not-started'
              : committed.length
                ? 'partial'
                : 'not-started',
            errorMessage:
              deleted.error ||
              'Ownership changed before workspace data could be removed.',
          });

          cancelled ||= deleted.cancelled === true;
          stopAt(index + 1, deleted.error);
          break;
        }

        finished.add(read.entry.workspaceDbPath);

        acceptedGlobal[read.entry.globalDbPath] = await databaseToken(
          read.entry.globalDbPath,
        );
      }

      if (ctx.signal?.aborted) {
        outcomes.push({
          kind: 'workspace-data',
          workspaceKey: read.entry.workspaceDbPath,
          label: target.name,
          chatIdsDeleted: committed,
          chatIdsSkipped: [],
          storage: 'not-started',
          errorMessage: 'Deletion cancelled after chat history was deleted.',
        });

        cancelled = true;
        stopAt(index + 1, 'Deletion cancelled.');
        break;
      }

      if (!read.directory)
        throw new Error('Workspace directory could not be resolved.');

      if (
        target.directoryId &&
        (await directoryIdentity(read.directory)) !== target.directoryId
      ) {
        outcomes.push({
          kind: 'workspace-data',
          workspaceKey: read.entry.workspaceDbPath,
          label: target.name,
          chatIdsDeleted: committed,
          chatIdsSkipped: [],
          storage: 'partial',
          errorMessage:
            'Workspace storage changed before its directory could be removed.',
        });

        stopAt(
          index + 1,
          'Workspace storage changed before its directory could be removed.',
        );

        break;
      }

      transferEvent({
        action: 'Remove workspace data started',
        status: 'info',
        path: read.directory,
      });

      try {
        await removeWorkspaceDirectory(read.directory);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);

        outcomes.push({
          kind: 'workspace-data',
          workspaceKey: read.entry.workspaceDbPath,
          label: target.name,
          chatIdsDeleted: committed,
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
        await lstat(read.directory);

        outcomes.push({
          kind: 'workspace-data',
          workspaceKey: read.entry.workspaceDbPath,
          label: target.name,
          chatIdsDeleted: committed,
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

        if (code !== 'ENOENT') {
          const message =
            cause instanceof Error ? cause.message : String(cause);

          outcomes.push({
            kind: 'workspace-data',
            workspaceKey: read.entry.workspaceDbPath,
            label: target.name,
            chatIdsDeleted: committed,
            chatIdsSkipped: [],
            storage: 'partial',
            errorMessage: message,
          });

          stopAt(index + 1, message);
          break;
        }
      }

      removed.add(read.entry.workspaceDbPath);

      transferEvent({
        action: 'Remove workspace data completed',
        status: 'completed',
        path: read.directory,
      });

      outcomes.push({
        kind: 'workspace-data',
        workspaceKey: read.entry.workspaceDbPath,
        label: target.name,
        chatIdsDeleted: committed,
        chatIdsSkipped: [],
        storage: 'deleted',
      });

      report();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);

      if (recorded) {
        stopAt(index + 1, message);
        break;
      }

      outcomes.push({
        kind: target.kind,
        workspaceKey: target.workspace.workspaceDbPath,
        label: target.name,
        chatIdsDeleted: committed,
        chatIdsSkipped: [],
        storage: committed.length ? 'partial' : 'not-started',
        errorMessage: message,
      });

      stopAt(index + 1, message);
      break;
    }
  }

  return { outcomes, cancelled, uncertain, error };
}

/**
 * Find workspaces whose supported indexes contain no chat history.
 * One ownership pass covers the whole scan. The current window is not selected.
 */
export async function findEmptyWorkspaces(
  /** Transfer hooks, timeouts, and cancellation. */
  ctx: TransferContext,
  /** Scan job without the kind tag. */
  job: Extract<DeletionJob, { kind: 'find-empty-workspaces' }>,
): Promise<EmptyWorkspaceScan> {
  let unchecked = 0;
  let candidates = 0;
  const empties: Array<{ workspace: WorkspaceEntry; ids: string[] }> = [];

  transferEvent({
    action: 'Find empty workspaces started',
    status: 'info',
    detail: `${job.workspaces.length} workspaces`,
  });

  for (const [index, entry] of job.workspaces.entries()) {
    ctx.signal?.throwIfAborted();

    ctx.onPhase?.('prepare', {
      processed: index + 1,
      total: job.workspaces.length,
      unit: 'workspaces',
    });

    const history = await assessWorkspaceHistory(ctx, entry);

    if (history.state === 'unknown' || history.state === 'unavailable') {
      unchecked += 1;
      continue;
    }

    if (history.state !== 'empty') continue;
    candidates += 1;
    if (await activeRefusal(entry, job)) continue;
    empties.push({ workspace: entry, ids: history.ids });
  }

  const selected: WorkspaceEntry[] = [];
  const owned = empties.filter((item) => item.ids.length);

  let ownership:
    Awaited<ReturnType<typeof inspectDeletionOwnership>> | undefined;

  if (owned.length)
    ownership = await inspectDeletionOwnership(
      ctx,
      job.workspaces,
      owned.map((item) => ({ workspace: item.workspace, ids: item.ids })),
    );

  for (const item of empties) {
    if (
      item.ids.length &&
      (!ownership ||
        !exclusivelyOwned(ownership.owners, item.workspace, item.ids))
    )
      continue;

    if (await foreignImageRefusal(ctx, item.workspace, item.ids)) continue;
    selected.push(item.workspace);
  }

  transferEvent({
    action: 'Find empty workspaces completed',
    status: 'completed',
    detail: `candidates=${candidates} selected=${selected.length} unchecked=${unchecked}`,
  });

  return { selected, unchecked, candidates };
}

/**
 * Hash the selected global chat rows.
 * Unrelated Cursor writes, including `agentKv` and editor state, are not part of the hash.
 */
async function chatSelectionFingerprint(
  /** Transfer hooks and the sqlite binary. */
  ctx: TransferContext,
  /** Global database that stores the chat rows. */
  database: string,
  /** Composer ids approved for this target. */
  ids: string[],
): Promise<string> {
  const hash = createHash('sha256');
  const sorted = [...new Set(ids)].sort();

  hash.update(sorted.join('\n'));

  if (!sorted.length) return hash.digest('hex');

  const hasTable = (
    await execSql({
      ...ctx,
      database,
      readOnly: true,
      sql: `SELECT count(*) FROM sqlite_schema WHERE type='table' AND name='composerHeaders';`,
    })
  ).trim();

  if (hasTable === '1') {
    await execSqlHexRows({
      ...ctx,
      database,
      readOnly: true,
      sql: `SELECT hex(composerId), hex(COALESCE(CAST(value AS BLOB), X'')) FROM composerHeaders WHERE composerId IN (${sorted.map((id) => sqlText(id)).join(',')}) ORDER BY composerId;`,
      cols: 2,
      onRow: (fields) => {
        hash.update(fields[0]);
        hash.update(fields[1]);
      },
    });
  }

  const batchSize = 64;

  for (let start = 0; start < sorted.length; start += batchSize) {
    const batch = sorted.slice(start, start + batchSize);

    const where = batch
      .map((id) => {
        const range = bubbleRange(id);

        return `key=${sqlText(`composerData:${id}`)} OR key=${sqlText(`composerRootWriterDiagnostic:${id}`)} OR (key>=${sqlText(range.lower)} AND key<${sqlText(range.upper)})`;
      })
      .join(' OR ');

    await execSqlHexRows({
      ...ctx,
      database,
      readOnly: true,
      sql: `SELECT hex(key), hex(COALESCE(CAST(value AS BLOB), X'')) FROM cursorDiskKV WHERE ${where} ORDER BY key;`,
      cols: 2,
      onRow: (fields) => {
        hash.update(fields[0]);
        hash.update(fields[1]);
      },
    });
  }

  return hash.digest('hex');
}
