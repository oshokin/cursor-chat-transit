import * as vscode from 'vscode';
import { acquireLock, type LockHandle } from './lock';
import { startOperationLog } from './operation-log';
import { phaseMessage, phaseProgress, type TransferKind } from './operation-ui';
import { TransferSidebar, type SidebarState } from './sidebar-provider';
import type {
  TransferPhase,
  TransferPhaseMetrics,
  WorkspaceEntry,
} from './types';
import { workspacePresentation } from './workspace-presentation';

/** Process-wide transfer UI: busy flag, cancellation, and the chosen workspace. */
export const runtime: {
  /** True while export or import holds the transfer lock. */
  busy: boolean;
  /** AbortController for the in-flight operation. */
  activeAbort?: AbortController;
  /** Workspace selected as the transfer source or target. */
  sourceWorkspace?: WorkspaceEntry;
  /** Registered sidebar view, if the webview has loaded. */
  sidebar?: TransferSidebar;
  /** Last state pushed to the sidebar. */
  uiState: SidebarState;
  /** Cached host capability for the Quit Cursor button. */
  canQuit: boolean;
} = { busy: false, uiState: idleState(), canQuit: false };

/** Initial sidebar labels. */
export function idleState(): SidebarState {
  return {
    workspaceLocation: '',
    workspaceName: 'Choose a workspace',
    workspaceDetail: 'Export from or import into this workspace.',
    sourceAvailable: false,
    busy: false,
    canCancel: false,
    canQuitCursor: false,
    importNeedsRestart: false,
    status: 'idle',
    statusTitle: 'No imports or exports yet',
    statusDetail: 'Choose an action to get started.',
    statusItems: [],
  };
}

/** Combine progress cancellation with the sidebar Cancel action. */
export function linkedSignal(token: vscode.CancellationToken): AbortSignal {
  const ac = new AbortController();
  runtime.activeAbort = ac;
  if (token.isCancellationRequested) ac.abort();
  token.onCancellationRequested(() => ac.abort());
  setUi({ canCancel: true });
  return ac.signal;
}

/** Drive the sidebar bar and Notification increment from transfer phases. */
export function attachPhaseProgress(
  vscodeProgress: vscode.Progress<{ message?: string; increment?: number }>,
  log: ReturnType<typeof startOperationLog>,
  kind: TransferKind,
): (phase: TransferPhase, metrics?: TransferPhaseMetrics) => void {
  let lastPct = 0;
  let lastPaint = 0;
  return (phase, metrics = {}) => {
    log.phase(phase, metrics);
    const message = phaseMessage(phase, metrics);
    const pct = Math.max(lastPct, phaseProgress(kind, phase, metrics));
    const increment = pct - lastPct;
    lastPct = pct;
    vscodeProgress.report(increment > 0 ? { message, increment } : { message });
    const now = Date.now();
    if (now - lastPaint < 80 && pct < 100 && increment === 0) return;
    lastPaint = now;
    setUi({ statusDetail: message, progress: pct });
  };
}

/** Push sidebar state and refresh the view if it exists. */
export function setUi(patch: Partial<SidebarState>): void {
  runtime.uiState = { ...runtime.uiState, ...patch };
  runtime.sidebar?.refresh();
}

/** Apply a selected source workspace to the sidebar card. */
export function setSource(entry: WorkspaceEntry | undefined): void {
  runtime.sourceWorkspace = entry;
  if (!entry) {
    setUi({
      workspaceLocation: '',
      workspaceName: 'Choose a workspace',
      workspaceDetail: 'Export from or import into this workspace.',
      sourceAvailable: false,
    });
    return;
  }
  const label = workspacePresentation(entry);
  setUi({
    workspaceName: label.name,
    workspaceDetail: label.path,
    workspaceLocation: label.location,
    sourceAvailable: true,
  });
}

/** Run `fn` under the in-process + file lock. */
export async function withLock<T>(
  context: vscode.ExtensionContext,
  fn: () => Promise<T>,
): Promise<T | undefined> {
  if (runtime.busy) {
    vscode.window.showWarningMessage('Cursor Chat Transit is already running.');
    return;
  }
  runtime.busy = true;
  setUi({
    busy: true,
    canCancel: false,
    status: 'running',
    importNeedsRestart: false,
    statusTitle: 'Preparing transfer…',
    statusDetail: 'Checking transfer availability.',
    statusItems: [],
    progress: undefined,
  });
  let lock: LockHandle | undefined;
  try {
    lock = await acquireLock(context.globalStorageUri.fsPath, 'transfer');
    return await fn();
  } finally {
    if (lock) await lock.release();
    runtime.busy = false;
    runtime.activeAbort = undefined;
    setUi({ busy: false, canCancel: false, progress: undefined });
  }
}
