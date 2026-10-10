import * as vscode from 'vscode';
import type {
  ManagedDeleteRequest,
  ManagedDeleteResult,
  ManagedPrepareResult,
} from './deletion-types';
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
import {
  currentWorkspaceDatabase,
  listHostEntries,
  prepareSqlite,
} from './extension-workspaces';
import {
  confirmationCopy,
  describeManagedResult,
  managedResultStatus,
} from './managed-delete-plan';
import { notifyCompletion } from './notifications';
import { startOperationLog } from './operation-log';
import type { TransitLog } from './output-ui';
import { runTransfer } from './transfer-process';
import type { WorkspaceIdentity } from './types';

/**
 * Confirm once, delete in the ordinary cancellable worker, then offer the existing Quit action.
 * Notification dismissal never owns the lock. Returns true when the tree needs a fresh read.
 */
export async function deleteManagedChats(
  /** Extension storage and host state. */
  context: vscode.ExtensionContext,
  /** Output channel or operation queue. */
  operations: TransitLog,
  /** Workspace data and individual chats. An empty workspace is not a no-op. */
  requests: ManagedDeleteRequest[],
): Promise<boolean> {
  if (!requests.length) {
    notifyCompletion(() =>
      vscode.window.showInformationMessage(
        'Select workspace data or individual chats. Project files are kept.',
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
    const host = listHostEntries();

    const windowFacts = {
      database: currentWorkspaceDatabase(context),
      identity: host.identity,
      emptyWindow:
        !vscode.workspace.workspaceFolders?.length &&
        !vscode.workspace.workspaceFile,
    };

    try {
      setUi({
        status: 'running',
        statusTitle: 'Preparing deletion…',
        statusDetail: 'Checking workspace data and chat ownership.',
      });

      const sqlite = await prepareSqlite(context);

      const prepared = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Preparing deletion',
          cancellable: true,
        },
        (progress, token) => {
          progress.report({
            message: 'Checking workspace data and chat ownership.',
          });

          return runTransfer<ManagedPrepareResult>(
            {
              kind: 'prepare-managed-delete',
              ...sqlite,
              ...transferSettings(),
              userDataRoot: host.userDir,
              requests,
              workspaces: host.entries,
              ...windowFacts,
            },
            {
              signal: linkedSignal(token),
              onEvent: log.event,
              onNote: log.note,
            },
          );
        },
      );

      if (!prepared.ok) {
        log.finish('failed', undefined, prepared.detail);

        setUi({
          status: 'failed',
          statusTitle: prepared.title,
          statusDetail: 'No data was deleted.',
          statusItems: [prepared.detail],
        });

        notifyCompletion(() =>
          Promise.resolve(
            vscode.window.showWarningMessage(
              prepared.title,
              {
                modal: true,
                detail: prepared.detail,
              },
              { title: 'Close', isCloseAffordance: true },
            ),
          ).then(() => undefined),
        );

        return;
      }

      for (const target of prepared.plan.targets)
        log.fact(
          `Workspace deletion prepared workspace=${JSON.stringify(target.name)} storageId=${JSON.stringify(target.workspace.storageId)} chats=${target.ids.length}`,
        );

      setUi({
        status: 'waiting',
        statusTitle: 'Confirm deletion',
        statusDetail: 'Review the selected workspace data and chats.',
      });

      const copy = confirmationCopy(prepared.plan);

      const decision = await vscode.window.showWarningMessage(
        copy.title,
        { modal: true, detail: copy.detail },
        { title: 'Cancel', isCloseAffordance: true },
        { title: copy.confirm },
      );

      if (decision?.title !== copy.confirm) {
        log.finish('cancelled');

        setUi({
          status: 'cancelled',
          statusTitle: 'Deletion cancelled',
          statusDetail: 'No data was deleted.',
        });

        return;
      }

      runtime.progressTimer = setInterval(
        () =>
          setUi({ timingLabel: `Elapsed ${humanDuration(log.elapsedMs())}` }),
        1000,
      );

      setUi({
        status: 'running',
        statusTitle: 'Deleting chat history…',
        statusDetail: 'Checking the confirmed plan again.',
      });

      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Deleting selected data',
          cancellable: true,
        },
        async (progress, token) => {
          workerStarted = true;
          const signal = linkedSignal(token);

          return runTransfer<ManagedDeleteResult>(
            {
              kind: 'delete-managed-data',
              ...sqlite,
              ...transferSettings(),
              plan: prepared.plan,
              workspaces: listHostEntries().entries,
              database: currentWorkspaceDatabase(context),
              identity: listHostEntries().identity as
                WorkspaceIdentity | undefined,
              emptyWindow: windowFacts.emptyWindow,
            },
            {
              signal,
              onEvent: (event) => {
                log.event(event);
                if (event.action === 'Remove workspace data started')
                  setUi({ statusTitle: 'Removing workspace data…' });
              },
              onNote: log.note,
              onPhase: (phase, metrics) => {
                log.phase(phase, metrics);
                const detail = `${metrics?.processed || 0}/${metrics?.total || prepared.plan.targets.length} workspaces processed · ${metrics?.chats || 0} chats deleted`;

                progress.report({ message: detail });

                setUi({
                  statusTitle:
                    phase === 'write'
                      ? 'Removing workspace data…'
                      : 'Deleting chat history…',
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

      const changed = result.outcomes.some(
        (outcome) =>
          outcome.chatIdsDeleted.length > 0 ||
          outcome.storage === 'deleted' ||
          outcome.storage === 'partial',
      );

      refresh = changed || result.uncertain === true;
      needsRestart ||= refresh;
      const summary = describeManagedResult(result);

      const status = managedResultStatus(result);

      log.fact(`Deletion summary: ${summary}`);
      if (result.error) log.note(`Deletion stopped: ${result.error}`);
      log.finish(status, undefined, result.error);

      setUi({
        status,
        statusTitle: result.cancelled
          ? 'Deletion cancelled'
          : result.error || result.uncertain
            ? 'Deletion stopped'
            : 'Deletion completed',
        statusDetail: summary,
        statusItems: result.error ? [result.error] : [],
      });

      notifyCompletion(() => vscode.window.showInformationMessage(summary));
    } catch (error) {
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
