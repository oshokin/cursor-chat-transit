import { notifyCompletion } from './notifications';
import { recoveryDetail } from './recovery-preview';
import { workspacePresentation } from './workspace-presentation';
import fs from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import { codeOf, isAbort, openLog } from './extension-errors';
import {
  transferSettings,
  importDirectory,
  rememberImportDir,
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
import { importDialogOptions, localBundlePath } from './file-dialogs';
import { runTransfer } from './transfer-process';
import { startOperationLog } from './operation-log';
import { formatImportNotice, resolveSelectedWorkspace } from './operation-ui';
import { type TransitLog } from './output-ui';
import type { WorkspaceEntry } from './types';

/** Import chats from a local ZIP archive into a picked workspace. */
export async function doImport(opts: {
  /** Extension host context used for settings and journal storage. */
  context: vscode.ExtensionContext;
  /** Operation log that records import progress and failures. */
  operations: TransitLog;
  /** Optional explicitly selected destination. */
  destination?: WorkspaceEntry;
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

    const resolved = resolveSelectedWorkspace(
      opts.destination || runtime.sourceWorkspace,
      entries,
    );

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

      workspace = await pickWorkspace(entries, identity, 'select', opts);
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
      async (
        /** Progress reporter for this operation. */
        progress,
        /** Cancellation token from the progress notification. */
        token,
      ) => {
        const signal = linkedSignal(token);
        const onPhase = attachPhaseProgress(progress, log, 'import');

        onPhase('read');

        let bytes: number | undefined;

        if (src.scheme === 'file') {
          try {
            bytes = (await fs.promises.stat(src.fsPath)).size;
          } catch {
            /* The read reports the real file error. */
          }
        }

        log.file(src.fsPath, bytes);
        const zipPath = await localBundlePath(src, signal);

        try {
          const settings = transferSettings();

          await rememberImportDir(opts.context, src);
          onPhase('validate');

          return await runTransfer<import('./types').ImportResult>(
            {
              kind: 'import',
              executable: sqlite.executable,
              initFile: sqlite.initFile,
              timeoutMs: settings.timeoutMs,
              busyTimeoutMs: settings.busyTimeoutMs,
              plansDir: settings.plansDir,
              workspace: destination,
              filePath: zipPath,
              interactiveRecovery: true,
              journalDir: path.join(
                opts.context.globalStorageUri.fsPath,
                'import-journals',
              ),
            },
            {
              signal,
              onPhase,
              onRecovery: async (
                /** Counts and examples; no message bodies. */
                preview,
              ) => {
                const place = workspacePresentation(destination);
                const detail = `${recoveryDetail(preview)}\n\nDestination: ${place.name} · ${place.location}\n${place.path}`;

                log.note(`Recovery inspection: ${detail}`);
                signal.throwIfAborted();

                setUi({
                  status: 'waiting',
                  statusTitle: 'Review incomplete archive',
                  statusDetail: 'Choose whether to import the available chats.',
                });

                const available = preview.complete + preview.historyOnly;

                // A no-result notice must never hold the worker or transfer lock.
                if (!available) return false;

                const action = 'Import available history';

                const choice = await vscode.window.showWarningMessage(
                  'This archive is incomplete.',
                  { modal: true, detail },
                  action,
                );

                signal.throwIfAborted();
                setUi({ status: 'running', statusTitle: 'Importing…' });

                return !!action && choice === action;
              },
              onNote: (message) => log.note(message),
              onEvent: (event) => log.event(event),
            },
          );
        } finally {
          if (src.scheme === 'vscode-remote') {
            const directory = path.dirname(zipPath);

            log.event({
              action: 'Remove temporary remote archive',
              status: 'started',
              path: directory,
            });

            try {
              await fs.promises.rm(directory, { recursive: true, force: true });

              log.event({
                action: 'Remove temporary remote archive',
                status: 'completed',
                path: directory,
              });
            } catch (error) {
              log.event({
                action: 'Remove temporary remote archive',
                status: 'failed',
                path: directory,
                errorCode: (error as NodeJS.ErrnoException).code,
              });
            }
          }
        }
      },
    );

    const notice = formatImportNotice(result);

    log.fact(
      `Import summary: imported=${result.imported} alreadyImported=${result.alreadyImported} newVersions=${result.newVersions} historyOnly=${result.historyOnly} skippedUnusable=${result.skipped}`,
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
        if (choice === 'Open log') return openLog(opts.operations);
      },
      () =>
        opts.operations.warn(
          'Unable to show completion notification or open the operation log.',
        ),
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

    if (code === 'NOTHING_TO_IMPORT') {
      log.finish('incomplete', code, err);

      setUi({
        status: 'incomplete',
        statusTitle: 'No recoverable chats',
        statusDetail:
          'Required message data is missing. Existing chats were kept. See the operation log.',
      });

      return;
    }

    const detail =
      err && typeof err === 'object' && 'detail' in err
        ? /** Second line of a notice. */
          String(
            (
              err as {
                /** Extra diagnostic stored on the error. */
                detail?: unknown;
              }
            ).detail || '',
          )
        : '';

    if (detail) log.note(detail);
    log.finish(code === 'PARTIAL' ? 'partial' : 'failed', code, err);

    throw err;
  } finally {
    finishPhaseProgress(log);
  }
}
