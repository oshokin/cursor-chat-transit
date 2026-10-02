import * as vscode from 'vscode';
import { transferSettings } from './extension-settings';
import { startOperationLog } from './operation-log';
import type { TransitLog } from './output-ui';
import { runTransfer } from './transfer-process';
import type { StatisticsJob, StatisticsUpdate } from './statistics';
import { showStatisticsPicker } from './statistics-picker';

/** Add one on-demand analysis action to an ordinary native picker. */
export function pickWithStatistics<T extends vscode.QuickPickItem>(options: {
  items: T[];
  key: (item: T) => string | undefined;
  title: string;
  placeholder: string;
  many?: boolean;
  buttonLabel: string;
  operations: TransitLog;
  job: () => Promise<StatisticsJob>;
}): Promise<T[] | undefined> {
  return showStatisticsPicker({
    ...options,
    picker: vscode.window.createQuickPick<T>(),
    analyzeButton: {
      iconPath: new vscode.ThemeIcon('graph'),
      tooltip: options.buttonLabel,
    },
    cancelButton: {
      iconPath: new vscode.ThemeIcon('debug-stop'),
      tooltip: 'Stop analysis',
    },
    run: async (
      signal: AbortSignal,
      update: (row: StatisticsUpdate) => void,
    ) => {
      const log = startOperationLog(
        options.operations,
        options.many ? 'chat statistics' : 'workspace statistics',
      );

      try {
        const job = await options.job();

        signal.throwIfAborted();

        const result = await runTransfer<{ failed: number }>(
          { ...job, ...transferSettings() },
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
    onError: () => undefined, // The operation log already records the failure; keep the picker open.
  });
}
