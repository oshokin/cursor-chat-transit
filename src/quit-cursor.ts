import { notifyCompletion } from './notifications';
import * as vscode from 'vscode';

/** Native desktop command used to quit this Cursor instance. Presence is checked at runtime. */
const QUIT_COMMAND = 'workbench.action.quit';

/** True when this desktop host is Cursor and exposes `workbench.action.quit`. */
export async function canQuitCursor(): Promise<boolean> {
  if (vscode.env.uiKind !== vscode.UIKind.Desktop) return false;
  if (!/\bcursor\b/i.test(vscode.env.appName)) return false;

  return (await vscode.commands.getCommands(true)).includes(QUIT_COMMAND);
}

/**
 * Returns a guarded Quit action for this extension host.
 * Cursor owns quit confirmation and unsaved-work prompts; this action adds no dialog.
 * The native command may be vetoed, so resolving it is not proof of shutdown.
 */
export function createQuitCursorAction(
  /** True while export or import still holds the transfer lock. */
  isBusy: () => boolean,
  /** True only when a modifying operation wrote data that Cursor must reload. */
  importNeedsRestart: () => boolean,
  /** Operation log that records a requested quit and any failure to invoke it. */
  log: {
    /** Record that the user requested native quit. */
    info(message: string): void;
    /** Record a failure to look up or invoke native quit. */
    error(message: string): void;
  },
): () => Promise<void> {
  /** Prevent overlapping requests while capability lookup or native quit is pending. */
  let requestingQuit = false;

  return async () => {
    if (requestingQuit || !importNeedsRestart()) return;

    if (isBusy()) {
      notifyCompletion(() =>
        vscode.window.showInformationMessage(
          'Wait for the current transfer to finish before quitting Cursor.',
        ),
      );

      return;
    }

    requestingQuit = true;

    try {
      if (!(await canQuitCursor())) {
        notifyCompletion(() =>
          vscode.window.showInformationMessage(
            'Quit Cursor from its application menu, then reopen it manually.',
          ),
        );

        return;
      }

      if (!importNeedsRestart()) return;

      if (isBusy()) {
        notifyCompletion(() =>
          vscode.window.showInformationMessage(
            'Wait for the current transfer to finish before quitting Cursor.',
          ),
        );

        return;
      }

      log.info('Quit Cursor requested by the user.');
      await vscode.commands.executeCommand(QUIT_COMMAND);
    } catch (error) {
      log.error(
        `Unable to request Cursor shutdown: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      notifyCompletion(() =>
        vscode.window.showErrorMessage(
          'Unable to quit Cursor. Use the application menu to quit it manually.',
        ),
      );
    } finally {
      requestingQuit = false;
    }
  };
}
