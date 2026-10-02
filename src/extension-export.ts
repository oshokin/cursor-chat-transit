import { pickWithStatistics } from './extension-statistics';
import path from 'node:path';
import * as vscode from 'vscode';
import {
  selectionForFilename,
  suggestExportFilename,
  workspaceNameFromIdentity,
} from './export-name';
import { codeOf, isAbort, openLog } from './extension-errors';
import {
  transferSettings,
  exportDirectory,
  rememberExportDir,
  requireLocalFile,
} from './extension-settings';
import {
  attachPhaseProgress,
  finishPhaseProgress,
  linkedSignal,
  runtime,
  setSource,
  setUi,
} from './extension-state';
import { hostState, pickWorkspace } from './extension-workspaces';
import { ZIP_FILTER } from './file-dialogs';
import { runTransfer } from './transfer-process';
import { startOperationLog } from './operation-log';
import { formatIncompleteExportNotice, notifyCompletion } from './operation-ui';
import { type TransitLog } from './output-ui';
import * as paths from './paths';
import { listWorkspaceChats } from './export-transfer';
import { chatPickItems } from './picker';

/** Export chats from the selected (or picked) workspace to a local JSON file. */
export async function doExport(opts: {
  /** Extension host context used for settings and remembered folders. */
  context: vscode.ExtensionContext;
  /** Operation log that records export progress and failures. */
  operations: TransitLog;
  /** When true, start from the current window's workspace when it is listed. */
  preferCurrent?: boolean;
}): Promise<void> {
  const log = startOperationLog(opts.operations, 'export');

  setUi({
    status: 'running',
    statusTitle: 'Preparing export…',
    statusDetail: 'Checking workspace availability.',
    progress: undefined,
    statusItems: [],
  });

  try {
    const { sqlite, userDir, entries, identity } = await hostState(
      opts.context,
    );

    let workspace = runtime.sourceWorkspace;

    if (opts.preferCurrent && identity) {
      workspace = paths.findWorkspaceByIdentity(userDir, identity) || workspace;
    }

    if (!workspace) {
      setUi({
        status: 'waiting',
        statusTitle: 'Choose a workspace',
        statusDetail: 'Select the workspace to export from.',
      });

      workspace = await pickWorkspace(entries, identity, 'export', opts);
      if (workspace) setSource(workspace);
    }

    if (!workspace) {
      log.finish('cancelled');

      setUi({
        status: 'cancelled',
        statusTitle: 'Export cancelled',
        statusDetail: 'No workspace selected.',
      });

      return;
    }

    const sqliteCtx = {
      ...sqlite,
      ...transferSettings(),
      onPhase: log.phase,
    };

    setUi({
      status: 'running',
      statusTitle: 'Loading chat list…',
      statusDetail: 'Looking up available chats.',
    });

    const listed = await listWorkspaceChats(
      { ...sqliteCtx, signal: undefined },
      workspace,
      { includeColumnDates: true },
    );

    if (!listed.allComposers.length) {
      log.finish('failed', 'NO_CHATS');

      setUi({
        status: 'failed',
        statusTitle: 'No chats found',
        statusDetail: 'No chats for this workspace identity.',
      });

      vscode.window.showWarningMessage(
        'No chats found for this workspace identity.',
      );

      return;
    }

    setUi({
      status: 'waiting',
      statusTitle: 'Choose chats to export',
      statusDetail: 'Export all chats or select individual conversations.',
    });

    const mode = await vscode.window.showQuickPick(
      [
        { label: 'Export all chats', value: 'all' as const },
        { label: 'Select chats…', value: 'select' as const },
      ],
      { title: 'Choose chats to export' },
    );

    if (!mode) {
      log.finish('cancelled');

      setUi({
        status: 'cancelled',
        statusTitle: 'Export cancelled',
        statusDetail: 'Chat selection was dismissed.',
      });

      return;
    }

    let selectedIds: string[] | undefined;

    if (mode.value === 'select') {
      setUi({
        statusTitle: 'Select chats to export',
        statusDetail: 'Choose the conversations to include.',
      });

      const picked = await pickWithStatistics({
        items: chatPickItems(listed.allComposers),
        key: (item) => item.id,
        many: true,
        title: 'Select chats to export',
        placeholder: 'Most recently updated first · Type to find a chat',
        buttonLabel: 'Count user messages and identify chat formats',
        operations: opts.operations,
        job: async () => ({
          ...sqliteCtx,
          kind: 'chat-statistics',
          workspace,
          chats: listed.allComposers.map(({ composerId, name }) => ({
            composerId,
            name,
          })),
        }),
      });

      if (!picked) {
        log.finish('cancelled');

        setUi({
          status: 'cancelled',
          statusTitle: 'Export cancelled',
          statusDetail: 'Chat selection was dismissed.',
        });

        return;
      }

      selectedIds = picked.map((p) => p.id);

      if (selectedIds.length === 0) {
        log.finish('cancelled');

        setUi({
          status: 'cancelled',
          statusTitle: 'Export cancelled',
          statusDetail: 'No chats selected.',
        });

        vscode.window.showInformationMessage(
          'Export cancelled: no chats selected.',
        );

        return;
      }
    }

    const selected =
      selectedIds === undefined
        ? listed.allComposers
        : listed.allComposers.filter((chat) =>
            selectedIds.includes(chat.composerId),
          );

    const filename = suggestExportFilename({
      workspaceName: workspaceNameFromIdentity(
        workspace.identity?.kind,
        workspace.identity?.uri.path,
      ),
      selection: selectionForFilename(
        mode.value === 'all' ? 'all' : 'selected',
        selected,
      ),
    });

    setUi({
      status: 'waiting',
      statusTitle: 'Choose where to save',
      statusDetail: 'Choose a location for the export.',
    });

    const saveUri = await vscode.window.showSaveDialog({
      title: `Export ${selected.length} Cursor chat(s)`,
      defaultUri: vscode.Uri.file(
        path.join(exportDirectory(opts.context), filename),
      ),
      filters: ZIP_FILTER,
      saveLabel: 'Export',
    });

    if (!saveUri) {
      log.finish('cancelled');

      setUi({
        status: 'cancelled',
        statusTitle: 'Export cancelled',
        statusDetail: 'Save dialog was dismissed.',
      });

      return;
    }

    const dest = requireLocalFile(saveUri, 'Export destination');

    log.file(dest);

    setUi({
      status: 'running',
      statusTitle: 'Exporting chats…',
      statusDetail: 'Reading selected chats.',
    });

    const summary = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Exporting chats',
        cancellable: true,
      },
      async (progress, token) =>
        runTransfer<
          | { skipped: true; reason: string }
          | import('./types').ExportObject['summary']
        >(
          {
            kind: 'export',
            executable: sqliteCtx.executable,
            initFile: sqliteCtx.initFile,
            timeoutMs: sqliteCtx.timeoutMs,
            busyTimeoutMs: sqliteCtx.busyTimeoutMs,
            plansDir: sqliteCtx.plansDir,
            workspace,
            filePath: dest,
            selectedIds,
          },
          {
            signal: linkedSignal(token),
            onPhase: attachPhaseProgress(progress, log, 'export'),
            onNote: (message) => log.note(message),
            onEvent: (event) => log.event(event),
          },
        ),
    );

    if (summary && 'skipped' in summary && summary.skipped) {
      log.finish('cancelled');

      return;
    }

    if (!summary || !('exported' in summary)) {
      log.finish('cancelled');

      return;
    }

    await rememberExportDir(opts.context, dest);

    if (!summary.complete) {
      const notice = formatIncompleteExportNotice(summary.issues || []);

      log.finish('incomplete');

      setUi({
        status: 'incomplete',
        statusTitle: `Exported ${summary.exported}/${summary.selected} chats`,
        statusDetail: notice.detail,
      });

      void vscode.window
        .showWarningMessage(notice.toast, 'Open log')
        .then((choice) => {
          if (choice === 'Open log') void openLog(opts.operations);
        });

      return;
    }

    log.finish('completed');

    setUi({
      status: 'completed',
      statusTitle: `Exported ${summary.exported} chat${summary.exported === 1 ? '' : 's'}`,
      statusDetail: path.basename(dest),
    });

    notifyCompletion(
      () =>
        vscode.window.showInformationMessage(
          `Exported ${summary.exported} chat${summary.exported === 1 ? '' : 's'}.`,
          'Open log',
        ),
      (choice) => {
        if (choice === 'Open log') void openLog(opts.operations);
      },
      () => opts.operations.warn('Unable to show completion notification.'),
    );
  } catch (err) {
    if (isAbort(err)) {
      log.finish('cancelled');

      setUi({
        status: 'cancelled',
        statusTitle: 'Export cancelled',
        statusDetail: 'The export was cancelled.',
      });

      return;
    }

    log.finish('failed', codeOf(err), err);

    throw err;
  } finally {
    finishPhaseProgress(log);
  }
}
