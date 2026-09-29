import * as vscode from 'vscode';
import { doDiagnostics } from './extension-diagnostics';
import { openLog, showFail } from './extension-errors';
import { doExport } from './extension-export';
import { doImport } from './extension-import';
import { runtime, setSource, setUi, withLock } from './extension-state';
import { listHostEntries, pickWorkspace } from './extension-workspaces';
import { asTransitLog, type TransitLog } from './output-ui';
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

/** Register commands, the sidebar view, and the two log channels. */
export function activate(context: vscode.ExtensionContext): void {
  /** Operation log opened by Open operation log. */
  const operations = asTransitLog(
    vscode.window.createOutputChannel('Cursor Chat Transit — Operations'),
  );
  /** Diagnostic log opened by Open diagnostic log. */
  const diagnostics = asTransitLog(
    vscode.window.createOutputChannel('Cursor Chat Transit — Diagnostics'),
  );
  /** Guarded Quit action; allowed only after an import that wrote chats. */
  const quitCursor = createQuitCursorAction(
    () => runtime.busy,
    () => runtime.uiState.importNeedsRestart === true,
    operations,
  );
  void canQuitCursor()
    .then((ok) => {
      runtime.canQuit = ok;
      setUi({ canQuitCursor: ok });
    })
    .catch(() => {
      runtime.canQuit = false;
      setUi({ canQuitCursor: false });
    });
  /** Dispatch one sidebar or command-palette action through the shared lock. */
  const runAction = async (action: SidebarAction): Promise<void> => {
    if (action === 'logs') {
      await openLog(operations);
      return;
    }
    if (action === 'diagnosticLogs') {
      await openLog(diagnostics);
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
      await doDiagnostics({ context, diagnostics });
      return;
    }
    if (action === 'chooseWorkspace') {
      if (runtime.busy) return;
      const { entries, identity } = listHostEntries();
      const picked = await pickWorkspace(entries, identity, 'select');
      if (picked) setSource(picked);
      return;
    }
    if (action === 'export') {
      await withLock(context, () => doExport({ context, operations }));
      return;
    }
    if (action === 'import') {
      await withLock(context, () => doImport({ context, operations }));
    }
  };
  runtime.sidebar = new TransferSidebar(
    context,
    () => runtime.uiState,
    runAction,
    (err) => showFail('Action', err, operations),
  );
  try {
    const listed = listHostEntries();
    const current =
      listed.identity &&
      paths.findWorkspaceByIdentity(listed.userDir, listed.identity);
    if (current) setSource(current);
  } catch {
    /* diagnostics remain available */
  }
  context.subscriptions.push(
    operations,
    diagnostics,
    vscode.window.registerWebviewViewProvider(
      'cursorChatTransit.view',
      runtime.sidebar,
    ),
    register(
      'cursorChatTransit.export',
      'Export',
      () => withLock(context, () => doExport({ context, operations })),
      operations,
    ),
    register(
      'cursorChatTransit.import',
      'Import',
      () => withLock(context, () => doImport({ context, operations })),
      operations,
    ),
    register(
      'cursorChatTransit.exportCurrentWorkspace',
      'Export',
      () =>
        withLock(context, () =>
          doExport({ context, operations, preferCurrent: true }),
        ),
      operations,
    ),
    register(
      'cursorChatTransit.diagnostics',
      'Diagnostics',
      () => doDiagnostics({ context, diagnostics }),
      operations,
    ),
    vscode.commands.registerCommand(
      'cursorChatTransit.showDiagnosticOutput',
      () => openLog(diagnostics),
    ),
    vscode.commands.registerCommand('cursorChatTransit.showOutput', () =>
      openLog(operations),
    ),
  );
}

/** VS Code requires this hook; this extension has no shutdown work. */
export function deactivate(): void {}
