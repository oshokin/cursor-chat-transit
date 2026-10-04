import * as vscode from 'vscode';
import { transferSettings } from './extension-settings';
import { startOperationLog } from './operation-log';
import type { TransitLog } from './output-ui';
import { runTransfer } from './transfer-process';
import type { StatisticsJob, StatisticsUpdate } from './statistics';
import { showStatisticsPicker } from './statistics-picker';

/** Add one on-demand analysis action to an ordinary native picker. */
export function pickWithStatistics<T extends vscode.QuickPickItem>(options: {
  /** Rows offered before analysis. */
  items: T[];
  /** Stable identity for one row. */
  key: (item: T) => string | undefined;
  /** Picker title. */
  title: string;
  /** Picker placeholder. */
  placeholder: string;
  /** When true, the caller is selecting chats rather than a workspace. */
  many?: boolean;
  /** Retain the current workspace when building the filtered list. */
  keepVisible?: (item: T) => boolean;
  /** Tooltip for the analysis button. */
  buttonLabel: string;
  /** Operation log for the scan. */
  operations: TransitLog;
  /** Build the statistics job when a scan starts. */
  job: () => Promise<StatisticsJob>;
}): Promise<T[] | undefined> {
  return showStatisticsPicker({
    ...options,
    autoFilter: !options.many,
    picker: vscode.window.createQuickPick<T>(),
    analyzeButton: {
      iconPath: new vscode.ThemeIcon('graph'),
      tooltip: options.buttonLabel,
    },
    action: options.many ? 'select' : 'filter',
    actionButton: {
      iconPath: new vscode.ThemeIcon(options.many ? 'check-all' : 'filter'),
      tooltip: options.many
        ? 'Check all chats and select complete ones with messages (replaces selection)'
        : 'Check chats and hide workspaces without readable history',
    },
    restoreButton: {
      iconPath: new vscode.ThemeIcon('eye'),
      tooltip: 'Show all workspaces',
    },
    hideButton: {
      iconPath: new vscode.ThemeIcon('eye-closed'),
      tooltip: 'Hide empty workspaces',
    },
    cancelButton: {
      iconPath: new vscode.ThemeIcon('debug-stop'),
      tooltip: 'Stop analysis',
    },
    run: async (
      signal: AbortSignal,
      /** Refresh the UI as results arrive. */
      update: (row: StatisticsUpdate) => void,
      /** When true, inspect message bodies. */
      deepCheck = false,
    ) => {
      const log = startOperationLog(
        options.operations,
        options.many ? 'chat statistics' : 'workspace statistics',
      );

      try {
        const job = await options.job();

        if (deepCheck)
          log.fact(
            options.many
              ? 'Check source data before selecting complete chats with messages'
              : 'Check workspace history before applying a view-only filter',
          );

        signal.throwIfAborted();

        /** How many items failed. */
        const result = await runTransfer<{
          /** How many checks failed. */
          failed: number;
        }>(
          { ...job, ...transferSettings(), deepCheck },
          {
            signal,
            onStatistics: update,
            onEvent: log.event,
            onNote: log.note,
          },
        );

        log.finish(
          signal.aborted
            ? 'cancelled'
            : result.failed
              ? 'incomplete'
              : 'completed',
        );

        return result;
      } catch (error) {
        log.finish(signal.aborted ? 'cancelled' : 'failed', undefined, error);

        throw error;
      }
    },
    onAction: (message) => options.operations.info(message),
    onError: () => undefined, // The operation log already records the failure; keep the picker open.
  });
}
