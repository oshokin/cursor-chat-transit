import * as vscode from 'vscode';
import { acquireLock, type LockHandle } from './lock';
import { startOperationLog } from './operation-log';
import { ProgressModel } from './progress-model';
import { humanDuration } from './duration';
import { phaseMessage, type TransferKind } from './operation-ui';
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
  /** Disposed when a progress scope ends or is replaced. */
  cancelSubscription?: vscode.Disposable;
  /** Repaints elapsed time while a transfer is running. */
  progressTimer?: ReturnType<typeof setInterval>;
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
export function linkedSignal(
  /** Cancellation token or lock token. */
  token: vscode.CancellationToken,
): AbortSignal {
  runtime.cancelSubscription?.dispose();
  const ac = new AbortController();

  runtime.activeAbort = ac;
  if (token.isCancellationRequested) ac.abort();
  runtime.cancelSubscription = token.onCancellationRequested(() => ac.abort());
  setUi({ canCancel: true });

  return ac.signal;
}

/** Drive the sidebar bar and Notification increment from transfer phases. */
export function attachPhaseProgress(
  /** Native progress notification. */
  vscodeProgress: vscode.Progress<{
    /** Progress text shown for this phase. */
    message?: string;
    /** Progress bar step, when the phase reports one. */
    increment?: number;
  }>,
  /** Operation log receiving the line. */
  log: ReturnType<typeof startOperationLog>,
  kind: TransferKind,
): (
  phase: TransferPhase,
  /** Progress counts for this phase. */
  metrics?: TransferPhaseMetrics,
) => void {
  const model = new ProgressModel(kind, log.startedAt);

  if (runtime.progressTimer) clearInterval(runtime.progressTimer);

  runtime.progressTimer = setInterval(() => {
    if (runtime.busy && runtime.uiState.status === 'running')
      setUi(model.snapshot());
  }, 1000);

  return (
    phase,
    /** Progress counts for this phase. */
    metrics = {},
  ) => {
    log.phase(phase, metrics);
    model.update(phase, metrics);
    const message = phaseMessage(phase, metrics, kind);

    vscodeProgress.report({ message });
    setUi({ statusDetail: message, ...model.snapshot() });
  };
}

/** Publish one frozen total from the log clock and remove obsolete stage details. */
export function finishPhaseProgress(
  /** Operation log receiving the line. */
  log: ReturnType<typeof startOperationLog>,
): void {
  clearInterval(runtime.progressTimer);
  runtime.progressTimer = undefined;

  setUi({
    canCancel: false,
    timingLabel: `Total ${humanDuration(log.elapsedMs())}`,
    stageLabel: '',
    currentItem: '',
    progress: undefined,
  });
}

/** Push sidebar state and refresh the view if it exists. */
export function setUi(
  /** Fields merged into the sidebar state. */
  patch: Partial<SidebarState>,
): void {
  runtime.uiState = { ...runtime.uiState, ...patch };
  if (
    patch.status &&
    ['completed', 'incomplete', 'cancelled', 'failed', 'partial'].includes(
      patch.status,
    )
  )
    runtime.uiState.canCancel = false;
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
  /** Extension storage and host state. */
  context: vscode.ExtensionContext,
  /** Work that runs while the lock is held. */
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
    stageLabel: '',
    currentItem: '',
    timingLabel: '',
    canRecoverLock: false,
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
    try {
      if (lock) await lock.release();
    } finally {
      clearInterval(runtime.progressTimer);
      runtime.progressTimer = undefined;
      runtime.busy = false;
      runtime.activeAbort = undefined;
      runtime.cancelSubscription?.dispose();
      runtime.cancelSubscription = undefined;

      setUi({
        busy: false,
        canCancel: false,
        progress: undefined,
        stageLabel: '',
        currentItem: '',
        timingLabel:
          runtime.uiState.timingLabel?.split('\n')[0]?.split(' · ')[0] || '',
      });
    }
  }
}
