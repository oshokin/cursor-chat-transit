import * as vscode from 'vscode';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

/** Sidebar button ids posted from the webview. */
export type SidebarAction =
  | 'chooseWorkspace'
  | 'export'
  | 'import'
  | 'diagnostics'
  | 'recoverLock'
  | 'logs'
  | 'cancel'
  | 'quitCursor';

/** Compact sidebar model: workspace labels, status, and optional progress. */
export interface SidebarState {
  /** Current workspace title. */
  workspaceName: string;
  /** Host or location line. */
  workspaceLocation?: string;
  /** Path or extra identity line. */
  workspaceDetail: string;
  /** Whether export can run against a selected source. */
  sourceAvailable: boolean;
  /** True while an operation holds the transfer lock. */
  busy: boolean;
  /** Whether the Cancel button should be shown. */
  canCancel: boolean;
  /** Visual status of the last or current operation. */
  status:
    | 'idle'
    | 'waiting'
    | 'running'
    | 'completed'
    | 'incomplete'
    | 'failed'
    | 'partial'
    | 'cancelled';
  /** Short status heading. */
  statusTitle: string;
  /** One-line status explanation. */
  statusDetail: string;
  /** Named chats or extra facts under the status. */
  statusItems?: string[];
  /** Determinate percent when known; omit for indeterminate. */
  progress?: number;
  /** Offer removal of a verified dead owner lock. */
  canRecoverLock?: boolean;
  /** Phase and timing details, scoped to the current measurable stage. */
  stageLabel?: string;
  /** Chat or file name currently being worked on. */
  currentItem?: string;
  /** Elapsed time and ETA for the current stage. */
  timingLabel?: string;
  /** Whether this desktop Cursor host can run the native quit command. */
  canQuitCursor?: boolean;
  /** True only when the last completed import wrote chats that Cursor must reload. */
  importNeedsRestart?: boolean;
}

/** Actions the host will honour from the webview. */
const ACTIONS = new Set<SidebarAction>([
  'chooseWorkspace',
  'export',
  'import',
  'diagnostics',
  'recoverLock',
  'logs',
  'cancel',
  'quitCursor',
]);

/** Render one small theme-aware sidebar; filesystem and database work stay in the host. */
export class TransferSidebar implements vscode.WebviewViewProvider {
  /** Attached sidebar webview, once the host has resolved it. */
  private view?: vscode.WebviewView;

  /** Record host callbacks; filesystem and database work stay in the extension. */
  constructor(
    /** Extension context used to load the sidebar HTML, CSS, and script. */
    private readonly context: vscode.ExtensionContext,
    /** Current sidebar model. */
    private readonly state: () => SidebarState,
    /** Host handler for one sidebar button. */
    private readonly run: (action: SidebarAction) => Promise<void>,
    /** Host handler when an action rejects. */
    private readonly onError: (error: unknown) => void,
  ) {}

  /** Supply local assets and a strict command allowlist to the webview. */
  async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
    this.view = view;

    const resources = vscode.Uri.joinPath(
      this.context.extensionUri,
      'resources',
    );

    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [resources],
    };

    const nonce = randomBytes(18).toString('base64');

    const template = await readFile(
      vscode.Uri.joinPath(resources, 'sidebar.html').fsPath,
      'utf8',
    );

    this.context.subscriptions.push(
      view.webview.onDidReceiveMessage((message: unknown) => {
        if (!message || typeof message !== 'object') return;
        const type = (message as { type?: unknown }).type;

        if (type === 'ready') {
          this.refresh();

          return;
        }

        if (typeof type !== 'string' || !ACTIONS.has(type as SidebarAction)) {
          return;
        }

        void this.run(type as SidebarAction).catch(this.onError);
      }),
    );

    view.webview.html = template
      .replaceAll('%%CSP_SOURCE%%', view.webview.cspSource)
      .replaceAll('%%NONCE%%', nonce)
      .replaceAll(
        '%%CSS_URI%%',
        view.webview
          .asWebviewUri(vscode.Uri.joinPath(resources, 'sidebar.css'))
          .toString(),
      )
      .replaceAll(
        '%%SCRIPT_URI%%',
        view.webview
          .asWebviewUri(vscode.Uri.joinPath(resources, 'sidebar-client.js'))
          .toString(),
      );

    this.context.subscriptions.push(
      view.onDidChangeVisibility(() => {
        if (view.visible) this.refresh();
      }),
    );
  }

  /** Re-send the latest small UI state after an operation changes or the view reappears. */
  refresh(): void {
    if (this.view)
      void this.view.webview.postMessage({
        type: 'state',
        state: this.state(),
      });
  }
}
