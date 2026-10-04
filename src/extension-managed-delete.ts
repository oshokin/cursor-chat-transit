import * as vscode from 'vscode';
import type { DeleteResult, DeleteTarget } from './deletion-types';
import { humanDuration } from './duration';
import { isAbort } from './extension-errors';
import { transferSettings } from './extension-settings';
import {
  finishPhaseProgress,
  linkedSignal,
  runtime,
  setUi,
  withLock,
} from './extension-state';
import { listHostEntries, prepareSqlite } from './extension-workspaces';
import { notifyCompletion } from './notifications';
import { startOperationLog } from './operation-log';
import type { TransitLog } from './output-ui';
import { runTransfer } from './transfer-process';
import { workspacePresentation } from './workspace-presentation';

/**
 * Confirm once, delete in the ordinary cancellable worker, then offer the existing Quit action.
 * Notification dismissal never owns the lock. Returns true when the tree needs a fresh read.
 */
export async function deleteManagedChats(
  /** Extension storage and host state. */
  context: vscode.ExtensionContext,
  /** Output channel or operation queue. */
  operations: TransitLog,
  /** Chats selected for deletion. */
  targets: DeleteTarget[],
): Promise<boolean> {
  if (
    !targets.some(
      (/** Deletion or import target. */ target) => target.ids.length,
    )
  ) {
    notifyCompletion(() =>
      vscode.window.showInformationMessage(
        'No chats selected. Check chats or workspaces to delete their history. Empty workspace storage is kept.',
      ),
    );

    return false;
  }

  const priorRestart = runtime.uiState.importNeedsRestart;
  let refresh = false;

  await withLock(context, async () => {
    const log = startOperationLog(operations, 'delete managed chats');
    let workerStarted = false;
    let needsRestart = priorRestart;

    try {
      const count = targets.reduce(
        (
          /** Running total. */
          sum,
          /** Deletion or import target. */
          target,
        ) => sum + new Set(target.ids).size,
        0,
      );

      const summary = targets
        .slice(0, 20)
        .map(
          (/** Deletion or import target. */ target) =>
            `${workspacePresentation(target.workspace).name} (${target.workspace.storageId}): ${target.ids.length} chat${target.ids.length === 1 ? '' : 's'}`,
        )
        .join('\n');

      setUi({
        status: 'waiting',
        statusTitle: 'Confirm deletion',
        statusDetail: `${count} chat${count === 1 ? '' : 's'} selected.`,
      });

      const decision = await vscode.window.showWarningMessage(
        `Delete ${count} selected chat${count === 1 ? '' : 's'}?`,
        {
          modal: true,
          detail: `Close all other Cursor windows and stop running Agent tasks before continuing. Do not use chats during deletion. Quit and reopen Cursor afterward.\n\nThis cannot be undone. Create your own backup first if you need to keep this history. Project files, workspace storage folders and shared resources are kept.\n\n${summary}${targets.length > 20 ? `\nAnd ${targets.length - 20} more workspaces.` : ''}`,
        },
        'Delete chats',
      );

      if (decision !== 'Delete chats') {
        log.finish('cancelled');

        setUi({
          status: 'cancelled',
          statusTitle: 'Deletion cancelled',
          statusDetail: 'No chats were changed.',
        });

        return;
      }

      const globals = new Set(
        targets.map(
          (/** Deletion or import target. */ target) =>
            target.workspace.globalDbPath,
        ),
      );

      const workspaces = listHostEntries().entries.filter((workspace) =>
        globals.has(workspace.globalDbPath),
      );

      const sqlite = await prepareSqlite(context);

      runtime.progressTimer = setInterval(
        () =>
          setUi({ timingLabel: `Elapsed ${humanDuration(log.elapsedMs())}` }),
        1000,
      );

      setUi({
        status: 'running',
        statusTitle: 'Deleting history…',
        statusDetail: 'Checking selected records and their ownership.',
      });

      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Deleting chat history',
          cancellable: true,
        },
        async (
          /** Progress reporter for this operation. */
          progress,
          /** Cancellation token from the progress notification. */
          token,
        ) => {
          const signal = linkedSignal(token);

          workerStarted = true;

          return runTransfer<DeleteResult>(
            {
              kind: 'delete-chats',
              ...sqlite,
              ...transferSettings(),
              workspaces,
              targets,
            },
            {
              signal,
              onEvent: log.event,
              onNote: log.note,
              onPhase: (
                phase,
                /** Progress counts for this phase. */
                metrics,
              ) => {
                log.phase(phase, metrics);
                const detail = `${metrics?.processed || 0}/${metrics?.total || targets.length} workspaces processed · ${metrics?.chats || 0} chats deleted`;

                progress.report({ message: detail });

                setUi({
                  statusDetail: detail,
                  progress: metrics?.total
                    ? ((metrics.processed || 0) / metrics.total) * 100
                    : undefined,
                });
              },
            },
          );
        },
      );

      refresh = result.deleted.length > 0 || result.uncertain === true;
      needsRestart ||= refresh;

      const status = result.cancelled
        ? 'cancelled'
        : result.error
          ? refresh
            ? 'partial'
            : 'failed'
          : result.skipped.length
            ? 'incomplete'
            : 'completed';

      const counts = `${result.uncertain ? 'At least ' : ''}${result.deleted.length} chats deleted · ${result.skipped.length} skipped${result.uncertain ? '; final commit outcome unknown' : ''}`;

      log.fact(`Deletion summary: ${counts}`);
      if (result.error) log.note(`Deletion stopped: ${result.error}`);
      log.finish(status, undefined, result.error);

      setUi({
        status,
        statusTitle: result.cancelled
          ? 'Deletion cancelled'
          : result.error
            ? 'Deletion stopped'
            : 'Deletion completed',
        statusDetail: `${counts}.${needsRestart ? ' Quit and reopen Cursor.' : ''}`,
        statusItems: result.error ? [result.error] : [],
      });

      notifyCompletion(() =>
        vscode.window.showInformationMessage(
          `${counts}.${needsRestart ? ' Quit and reopen Cursor using the button in Cursor Chat Transit.' : ''}`,
        ),
      );
    } catch (error) {
      // A disconnected worker can have committed immediately before losing IPC.
      refresh ||= workerStarted;
      needsRestart ||= workerStarted;
      log.finish(isAbort(error) ? 'cancelled' : 'failed', undefined, error);

      setUi({
        status: isAbort(error) ? 'cancelled' : 'failed',
        statusTitle: 'Deletion stopped',
        statusDetail: workerStarted
          ? 'The final result is unavailable. Check Operations, then quit and reopen Cursor before retrying.'
          : 'No deletion started. Check Operations.',
        statusItems: [error instanceof Error ? error.message : String(error)],
      });
    } finally {
      finishPhaseProgress(log);
      setUi({ importNeedsRestart: needsRestart });
    }
  });

  return refresh;
}
