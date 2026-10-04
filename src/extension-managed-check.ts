import * as vscode from 'vscode';
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
import { prepareSqlite } from './extension-workspaces';
import type { ManagedNode } from './managed-node';
import { groupManagedNodes } from './managed-selection';
import { notifyCompletion } from './notifications';
import { startOperationLog } from './operation-log';
import type { TransitLog } from './output-ui';
import { workspaceStatisticsKey, type StatisticsUpdate } from './statistics';
import { runTransfer } from './transfer-process';

/** Inspect the mixed selection under one lock/progress scope and one worker job per workspace. */
export async function checkManagedNodes(
  /** Extension storage and host state. */
  context: vscode.ExtensionContext,
  /** Output channel or operation queue. */
  operations: TransitLog,
  nodes: ManagedNode[],
  /** Refresh the UI as results arrive. */
  update: (node: ManagedNode, row: StatisticsUpdate) => void,
): Promise<void> {
  const groups = groupManagedNodes(nodes);

  if (!groups.length) {
    notifyCompletion(() =>
      vscode.window.showInformationMessage(
        'Select a workspace or chat, then choose Check.',
      ),
    );

    return;
  }

  const needsRestart = runtime.uiState.importNeedsRestart;

  await withLock(context, async () => {
    const log = startOperationLog(operations, 'check managed chats');

    runtime.progressTimer = setInterval(
      () => setUi({ timingLabel: `Elapsed ${humanDuration(log.elapsedMs())}` }),
      1000,
    );

    setUi({
      status: 'running',
      statusTitle: 'Checking chats…',
      statusDetail: 'Reading source data. No Cursor data will be changed.',
    });

    let checked = 0;
    let failed = 0;

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Checking chats',
          cancellable: true,
        },
        async (
          /** Progress reporter for this operation. */
          progress,
          /** Cancellation token from the progress notification. */
          token,
        ) => {
          const signal = linkedSignal(token);
          const sqlite = await prepareSqlite(context);
          const settings = transferSettings();

          for (const [index, group] of groups.entries()) {
            signal.throwIfAborted();
            let workspaceCount = 0;

            /** How many items failed. */
            const result = await runTransfer<{
              /** How many checks failed. */
              failed: number;
            }>(
              {
                kind: 'chat-statistics',
                ...sqlite,
                ...settings,
                workspace: group.workspace,
                chats: group.chats,
                deepCheck: true,
              },
              {
                signal,
                onEvent: log.event,
                onNote: log.note,
                onStatistics: (row) => {
                  checked++;
                  workspaceCount++;

                  update(
                    {
                      workspace: group.workspace,
                      chat: { composerId: row.key },
                    },
                    row,
                  );

                  const detail = `${checked} chats checked · Workspace ${index + 1}/${groups.length}`;

                  progress.report({ message: detail });
                  setUi({ statusDetail: detail });
                },
              },
            );

            failed += result.failed;
            if (!group.chats)
              update(
                { workspace: group.workspace },
                {
                  key: workspaceStatisticsKey(group.workspace),
                  detail: `${workspaceCount} checked · ${result.failed} checks unavailable`,
                },
              );
          }
        },
      );

      log.finish(failed ? 'incomplete' : 'completed');

      setUi({
        status: failed ? 'incomplete' : 'completed',
        statusTitle: 'Check completed',
        statusDetail: `${checked} chats checked · ${failed} checks unavailable`,
      });
    } catch (error) {
      log.finish(isAbort(error) ? 'cancelled' : 'failed', undefined, error);
      if (!isAbort(error)) throw error;

      setUi({
        status: 'cancelled',
        statusTitle: 'Check cancelled',
        statusDetail: `${checked} completed checks are kept until Refresh.`,
      });
    } finally {
      finishPhaseProgress(log);
      setUi({ importNeedsRestart: needsRestart });
    }
  });
}
