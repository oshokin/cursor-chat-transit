import * as vscode from 'vscode';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

/** Sidebar button ids posted from the webview. */
export type SidebarAction =
  | 'chooseWorkspace'
  | 'export'
  | 'import'
  | 'diagnostics'
  | 'diagnosticLogs'
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
  'diagnosticLogs',
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
    private readonly context: vscode.ExtensionContext,
    private readonly state: () => SidebarState,
    private readonly run: (action: SidebarAction) => Promise<void>,
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
    const [template, brandIcon] = await Promise.all([
      readFile(vscode.Uri.joinPath(resources, 'sidebar.html').fsPath, 'utf8'),
      readFile(
        vscode.Uri.joinPath(resources, 'icons', 'activity-bar.svg').fsPath,
        'utf8',
      ),
    ]);
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
      // Trusted packaged asset; never interpolate an export or workspace value here.
      .replaceAll('%%BRAND_ICON%%', brandIcon)
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
