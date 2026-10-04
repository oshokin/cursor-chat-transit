import * as vscode from 'vscode';
import { registerManager } from './extension-manager';
import { openLog, showFail, recoverStaleTransfer } from './extension-errors';
import { operationLogLevel } from './extension-settings';
import { runtime, setSource, setUi, withLock } from './extension-state';
import { listHostEntries, pickWorkspace } from './extension-workspaces';
import { asTransitLog, gateOperationLog, type TransitLog } from './output-ui';
import * as paths from './paths';
import { canQuitCursor, createQuitCursorAction } from './quit-cursor';
import { TransferSidebar, type SidebarAction } from './sidebar-provider';

/** Register a command and surface failures with `action failed:`. */
function register(
  /** Full command id, such as `cursorChatTransit.export`. */
  command: string,
  /** Short action name used in failure copy. */
  action: string,
  /** Work invoked when the command runs. */
  run: () => Promise<unknown>,
  /** Operation log that receives a failure. */
  log: TransitLog,
): vscode.Disposable {
  return vscode.commands.registerCommand(command, () =>
    run().catch((err: unknown) => showFail(action, err, log)),
  );
}

/** Register commands, the sidebar view, and the operation log channel. */
export function activate(
  /** Extension storage and host state. */
  context: vscode.ExtensionContext,
): void {
  /** Plain channel: Cursor does not reveal a `{ log: true }` channel. */
  const operationChannel = vscode.window.createOutputChannel(
    'Cursor Chat Transit — Operations',
  );

  /** Operation log opened by Open operation log. */
  const operations = gateOperationLog(
    asTransitLog(operationChannel),
    operationLogLevel,
  );

  /** Guarded Quit action; allowed only after an import that wrote chats. */
  const quitCursor = createQuitCursorAction(
    () => runtime.busy,
    () => runtime.uiState.importNeedsRestart === true,
    operations,
  );

  void canQuitCursor()
    .then((/** Whether the step succeeded. */ ok) => {
      runtime.canQuit = ok;
      setUi({ canQuitCursor: ok });
    })
    .catch(() => {
      runtime.canQuit = false;
      setUi({ canQuitCursor: false });
    });

  /** Dispatch one sidebar or command-palette action through the shared lock. */
  const runAction = async (
    /** Sidebar or command action. */
    action: SidebarAction,
  ): Promise<void> => {
    if (action === 'manage') {
      await vscode.commands.executeCommand('cursorChatTransit.manage.focus');

      return;
    }

    if (action === 'logs') {
      await openLog(operations);

      return;
    }

    if (action === 'recoverLock') {
      await recoverStaleTransfer(operations);

      return;
    }

    if (action === 'cancel') {
      runtime.activeAbort?.abort();

      return;
    }

    if (action === 'quitCursor') {
      await quitCursor();

      return;
    }

    if (action === 'diagnostics') {
      const { doDiagnostics } = await import('./extension-diagnostics');

      await doDiagnostics({ context });

      return;
    }

    if (action === 'chooseWorkspace') {
      if (runtime.busy) return;
      const { entries, identity } = listHostEntries();

      const picked = await pickWorkspace(entries, identity, 'select', {
        context,
        operations,
      });

      if (picked) setSource(picked);

      return;
    }

    if (action === 'export') {
      const { doExport } = await import('./extension-export');

      await withLock(context, () => doExport({ context, operations }));

      return;
    }

    if (action === 'import') {
      const { doImport } = await import('./extension-import');

      await withLock(context, () => doImport({ context, operations }));
    }
  };

  runtime.sidebar = new TransferSidebar(
    context,
    () => runtime.uiState,
    runAction,
    (err) => showFail('Action', err, operations),
  );

  context.subscriptions.push(
    operations,
    vscode.window.registerWebviewViewProvider(
      'cursorChatTransit.view',
      runtime.sidebar,
    ),
    register(
      'cursorChatTransit.export',
      'Export',
      async () => {
        const { doExport } = await import('./extension-export');

        return withLock(context, () => doExport({ context, operations }));
      },
      operations,
    ),
    register(
      'cursorChatTransit.import',
      'Import',
      async () => {
        const { doImport } = await import('./extension-import');

        return withLock(context, () => doImport({ context, operations }));
      },
      operations,
    ),
    register(
      'cursorChatTransit.exportCurrentWorkspace',
      'Export',
      async () => {
        const { doExport } = await import('./extension-export');

        return withLock(context, () =>
          doExport({ context, operations, preferCurrent: true }),
        );
      },
      operations,
    ),
    register(
      'cursorChatTransit.diagnostics',
      'Diagnostics',
      async () => {
        const { doDiagnostics } = await import('./extension-diagnostics');

        return doDiagnostics({ context });
      },
      operations,
    ),
    vscode.commands.registerCommand('cursorChatTransit.showOutput', () =>
      openLog(operations),
    ),
  );

  registerManager(context, operations);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      // A selected entry belongs to the previous profile; the next operation must choose anew.
      if (event.affectsConfiguration('cursorChatTransit.userDataDir'))
        setSource(undefined);
    }),
  );

  setImmediate(() => {
    try {
      const listed = listHostEntries();

      const current =
        listed.identity &&
        paths.findWorkspaceByIdentity(listed.userDir, listed.identity);

      if (current) setSource(current);
    } catch {
      /* diagnostics remain available */
    }
  });
}

/** VS Code requires this hook; this extension has no shutdown work. */
export function deactivate(): void {
  runtime.activeAbort?.abort();
}
