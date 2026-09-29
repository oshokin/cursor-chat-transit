import path from 'node:path';
import * as vscode from 'vscode';
import { codeOf, isAbort, openLog } from './extension-errors';
import {
  transferSettings,
  importAllowPartial,
  importDirectory,
  rememberImportDir,
} from './extension-settings';
import {
  attachPhaseProgress,
  linkedSignal,
  runtime,
  setSource,
  setUi,
} from './extension-state';
import { hostState, pickWorkspace } from './extension-workspaces';
import { importDialogOptions, readExportUri } from './file-dialogs';
import { startOperationLog } from './operation-log';
import {
  formatImportNotice,
  notifyCompletion,
  resolveSelectedWorkspace,
} from './operation-ui';
import { type TransitLog } from './output-ui';
import * as transfer from './transfer';
import type { WorkspaceEntry } from './types';

/** Import chats from a local JSON file into a picked workspace. */
export async function doImport(opts: {
  /** Extension host context used for settings and journal storage. */
  context: vscode.ExtensionContext;
  /** Operation log that records import progress and failures. */
  operations: TransitLog;
}): Promise<void> {
  const log = startOperationLog(opts.operations, 'import');
  setUi({
    status: 'waiting',
    statusTitle: 'Choose an export file',
    statusDetail: 'Choose an export file for the selected workspace.',
    progress: undefined,
    statusItems: [],
  });
  try {
    const open = await vscode.window.showOpenDialog(
      importDialogOptions(importDirectory(opts.context)),
    );
    if (!open || !open[0]) {
      log.finish('cancelled');
      setUi({
        status: 'cancelled',
        statusTitle: 'Import cancelled',
        statusDetail: 'No export file selected.',
      });
      return;
    }
    setUi({
      status: 'running',
      statusTitle: 'Preparing import…',
      statusDetail: 'Checking workspace availability.',
    });
    const src = open[0];
    const { sqlite, entries, identity } = await hostState(opts.context);
    const resolved = resolveSelectedWorkspace(runtime.sourceWorkspace, entries);
    let workspace: WorkspaceEntry | undefined;
    if (resolved.status === 'ok') workspace = resolved.workspace;
    else if (resolved.status === 'missing') {
      log.finish('failed', 'STALE_WORKSPACE');
      setUi({
        status: 'failed',
        statusTitle: 'Workspace unavailable',
        statusDetail: 'Selected workspace is no longer available.',
      });
      vscode.window.showErrorMessage(
        'Selected workspace is no longer available. Choose a workspace and try again.',
      );
      return;
    } else {
      setUi({
        status: 'waiting',
        statusTitle: 'Choose a workspace',
        statusDetail: 'Select the workspace to import into.',
      });
      workspace = await pickWorkspace(entries, identity, 'select');
      if (workspace) setSource(workspace);
    }
    if (!workspace) {
      log.finish('cancelled');
      setUi({
        status: 'cancelled',
        statusTitle: 'Import cancelled',
        statusDetail: 'No destination workspace selected.',
      });
      return;
    }
    setUi({
      status: 'running',
      statusTitle: 'Importing…',
      statusDetail: 'Reading export file…',
    });
    const destination = workspace;
    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Importing chats',
        cancellable: true,
      },
      async (progress, token) => {
        const signal = linkedSignal(token);
        const onPhase = attachPhaseProgress(progress, log, 'import');
        onPhase('read');
        const obj = await readExportUri(src, signal);
        await rememberImportDir(opts.context, src);
        onPhase('validate');
        return transfer.importFromObject(
          {
            ...sqlite,
            ...transferSettings(),
            signal,
            onPhase,
            onNote: (message) => log.note(message),
          },
          obj,
          destination,
          {
            allowPartial: importAllowPartial(),
            journalDir: path.join(
              opts.context.globalStorageUri.fsPath,
              'import-journals',
            ),
          },
        );
      },
    );
    const notice = formatImportNotice(result);
    log.note(
      `imported=${result.imported} alreadyImported=${result.alreadyImported} newVersions=${result.newVersions} historyOnly=${result.historyOnly} skippedUnusable=${result.skipped}`,
    );
    log.finish(notice.status === 'incomplete' ? 'incomplete' : 'completed');
    setUi({
      importNeedsRestart: notice.restart,
      status: notice.status,
      statusTitle: notice.title,
      statusDetail: notice.detail,
      statusItems: notice.items,
    });
    notifyCompletion(
      () => vscode.window.showInformationMessage(notice.toast, 'Open log'),
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
        statusTitle: 'Import cancelled',
        statusDetail: 'The import was cancelled.',
      });
      return;
    }
    const code = codeOf(err);
    const detail =
      err && typeof err === 'object' && 'detail' in err
        ? String((err as { detail?: unknown }).detail || '')
        : '';
    if (detail) log.note(detail);
    log.finish(code === 'PARTIAL' ? 'partial' : 'failed', code);
    throw err;
  }
}
