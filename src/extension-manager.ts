import * as vscode from 'vscode';
import path from 'node:path';
import { isAbort, showFail } from './extension-errors';
import { checkManagedNodes } from './extension-managed-check';
import { deleteManagedChats } from './extension-managed-delete';
import { transferSettings } from './extension-settings';
import { linkedSignal, withLock } from './extension-state';
import {
  currentWorkspaceDatabase,
  listHostEntries,
  prepareSqlite,
} from './extension-workspaces';
import type { ManagedNode } from './managed-node';
import { managedSearchItems, showManagedSearch } from './managed-search';
import { requestsFromNodes, selectionSummary } from './managed-delete-plan';
import { ManagedSelection } from './managed-selection';
import { startOperationLog } from './operation-log';
import type { TransitLog } from './output-ui';
import { orderedChatHeaders, workspacePickItems } from './picker';
import { listIncompleteWorkspaceDirs } from './paths';
import { workspaceStatisticsKey, type StatisticsUpdate } from './statistics';
import { runTransfer } from './transfer-process';
import type { EmptyWorkspaceScan } from './deletion-types';
import type { ComposerHeader, WorkspaceEntry } from './types';
import { workspacePresentation } from './workspace-presentation';

/** A native, lazy tree. Its lifetime and its jobs do not depend on keyboard focus. */
export class ChatManager
  implements vscode.TreeDataProvider<ManagedNode>, vscode.Disposable
{
  /** Notifies the tree view that rows changed. */
  private readonly changed = new vscode.EventEmitter<ManagedNode | undefined>();
  /** Tree refresh event required by VS Code. */
  readonly onDidChangeTreeData = this.changed.event;
  /** In-flight chat lists, keyed by workspace, so expand does not reread. */
  private readonly lists = new Map<string, Promise<ManagedNode[]>>();
  /** Check results keyed by workspace or chat. */
  private readonly results = new Map<string, StatisticsUpdate>();
  /** Cancels chat loads when the view is disposed. */
  private loading = new AbortController();
  /** One shared scan per refresh, rather than a worker for every workspace. */
  private roots?: Promise<ManagedNode[]>;
  /** Do not open overlapping search pickers. */
  private searching?: Promise<void>;
  /** Coalesces tree repaints while many chats are checked. */
  private repaint?: ReturnType<typeof setTimeout>;

  /** Explicit selection is independent of focused tree rows. */
  readonly selection = new ManagedSelection();
  /** Toggle only view filtering; never deletes data. */
  private showAll = false;
  /** Summary used when nothing is selected and no operation message is active. */
  private filterSummary =
    'Select workspace data or individual chats. Project files are kept.';
  /** Temporary status that outranks the selection summary. */
  private operationMessage?: string;
  /** Invalidates a scan when the tree is refreshed or disposed. */
  private generation = 0;

  /** Apply one checkbox change and update all affected rows. */
  async select(node: ManagedNode, checked: boolean): Promise<void> {
    const generation = this.loading.signal;
    const parent = { workspace: node.workspace };

    this.operationMessage = undefined;
    if (!node.chat && this.isCurrentRoot(node)) return;
    if (!checked && node.chat && this.selection.has(parent)) {
      const siblings = await this.getChildren(parent);

      if (generation.aborted) return;
      if (siblings.some((item) => item.error))
        throw new Error(
          'Unable to update selection. Refresh the workspace and try again.',
        );
      this.selection.set(parent, false);
      for (const sibling of siblings)
        if (sibling.chat?.composerId !== node.chat.composerId)
          this.selection.set(sibling, true);
    } else this.selection.set(node, checked);
    this.publishMessage();
    this.changed.fire(undefined);
  }
  /** Select visible workspace rows that can be deleted. The current window is excluded. */
  async selectAll(): Promise<void> {
    this.operationMessage = undefined;
    const roots = await this.getChildren();

    this.selection.selectWorkspaces(
      roots.filter((node) => !this.isCurrentRoot(node)),
    );

    this.publishMessage();
    this.changed.fire(undefined);
  }
  /** Clear hidden and visible selections alike. */
  clearSelection(): void {
    this.operationMessage = undefined;
    this.selection.clear();
    this.publishMessage();
    this.changed.fire(undefined);
  }
  /** Keep the visibility command present in both states. */
  toggleVisibility(): void {
    this.showAll = !this.showAll;

    void vscode.commands.executeCommand(
      'setContext',
      'cursorChatTransit.manageShowAll',
      this.showAll,
    );

    this.publishMessage();
    this.changed.fire(undefined);
  }
  /** Check the explicit selection through the existing checker. */
  async checkSelected(): Promise<void> {
    await this.checkNodes(this.selection.values());
  }

  /** Resolve checked scopes before row fallback; keyboard focus never changes deletion targets. */
  async deleteSelected(node?: ManagedNode): Promise<void> {
    this.loading.abort();
    await Promise.allSettled([...this.lists.values()]);
    const checked = this.selection.values();

    const requests = requestsFromNodes(
      checked.length ? checked : node && !node.error ? [node] : [],
    );

    if (await deleteManagedChats(this.context, this.operations, requests))
      this.refresh();
  }

  /**
   * Replace the checked set with workspaces that have no supported chat history.
   * Hidden rows are included. A selection edit during the scan keeps the user's set.
   */
  async selectEmpty(): Promise<ManagedNode | undefined> {
    const generation = this.generation;
    const revision = this.selection.revision;

    this.operationMessage = 'Finding empty workspaces…';
    this.publishMessage();

    let scan: EmptyWorkspaceScan | undefined;

    try {
      scan = await withLock(
        this.context,
        async () => {
          const sqlite = await prepareSqlite(this.context);
          const host = listHostEntries();

          return vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: 'Finding empty workspaces…',
              cancellable: true,
            },
            (progress, token) =>
              runTransfer<EmptyWorkspaceScan>(
                {
                  kind: 'find-empty-workspaces',
                  ...sqlite,
                  ...transferSettings(),
                  userDataRoot: host.userDir,
                  workspaces: host.entries,
                  database: currentWorkspaceDatabase(this.context),
                  identity: host.identity,
                  emptyWindow:
                    !vscode.workspace.workspaceFolders?.length &&
                    !vscode.workspace.workspaceFile,
                },
                {
                  signal: linkedSignal(token),
                  onPhase: (_phase, metrics) => {
                    const message = `Checked ${metrics?.processed || 0} of ${metrics?.total || host.entries.length} workspaces`;

                    progress.report({ message });
                    this.operationMessage = `Finding empty workspaces… ${message}`;
                    this.publishMessage();
                  },
                },
              ),
          );
        },
        {
          title: 'Finding empty workspaces…',
          detail: 'Checking workspaces for chat history.',
        },
      );
    } catch (error) {
      this.operationMessage = undefined;
      this.publishMessage();
      if (isAbort(error)) return undefined;

      throw error;
    }

    if (!scan) {
      this.operationMessage = undefined;
      this.publishMessage();

      return undefined;
    }

    if (
      generation !== this.generation ||
      revision !== this.selection.revision
    ) {
      this.operationMessage =
        'Selection changed while checking. Run Select empty workspaces again.';

      this.publishMessage();

      return undefined;
    }

    if (!scan.selected.length) {
      this.operationMessage = scan.unchecked
        ? `No empty workspaces found. Selection unchanged. ${scan.unchecked} could not be checked.`
        : 'No empty workspaces found. Selection unchanged.';

      this.publishMessage();

      return undefined;
    }

    this.showAll = true;

    void vscode.commands.executeCommand(
      'setContext',
      'cursorChatTransit.manageShowAll',
      true,
    );

    this.selection.clear();

    this.selection.selectWorkspaces(
      scan.selected.map((workspace) => ({ workspace, requireEmpty: true })),
    );

    const roots = await this.getChildren();

    this.operationMessage = `${scan.selected.length} workspace${scan.selected.length === 1 ? '' : 's'} with no chat history selected.${scan.unchecked ? ` ${scan.unchecked} could not be checked.` : ''}`;
    this.publishMessage();
    this.changed.fire(undefined);

    const first = scan.selected[0];

    return roots.find(
      (node) =>
        !node.chat &&
        node.workspace.workspaceDbPath === first.workspaceDbPath &&
        node.workspace.globalDbPath === first.globalDbPath,
    );
  }

  /** Physical database of the workspace open in this window. */
  private isCurrentRoot(node: ManagedNode): boolean {
    if (node.chat || node.error) return false;
    const current = currentWorkspaceDatabase(this.context);

    return (
      !!current &&
      path.resolve(current) === path.resolve(node.workspace.workspaceDbPath)
    );
  }

  /** Selection outranks the filter summary. An in-progress operation outranks both. */
  private publishMessage(): void {
    const selected = this.selection.values();

    const hidden = this.showAll
      ? 0
      : selected.filter(
          (node) =>
            !node.chat &&
            !node.error &&
            (this.results.get(this.key(node))?.hide ||
              this.results.get(this.key(node))?.failed),
        ).length;

    this.listMessage(
      this.operationMessage ||
        (selected.length
          ? selectionSummary(selected, hidden)
          : this.filterSummary),
    );
  }

  /** Bind the tree to the extension lifetime and the operation log. */
  constructor(
    /** Extension host context for settings and transfer state. */
    private readonly context: vscode.ExtensionContext,
    /** Operation log for load, check, and recovery. */
    private readonly operations: TransitLog,
    /** Native view message, independent of the shared transfer sidebar. */
    private readonly listMessage: (message: string) => void = () => {},
  ) {}

  /** Stop loads and release the tree event. */
  dispose(): void {
    this.generation += 1;
    this.loading.abort();
    clearTimeout(this.repaint);
    this.changed.dispose();
  }

  /** Drop cached chat lists and check results, then redraw. */
  refresh(): void {
    this.generation += 1;
    this.loading.abort();
    this.loading = new AbortController();
    this.roots = undefined;
    this.lists.clear();
    this.selection.clear();
    this.results.clear();
    this.changed.fire(undefined);
  }

  /** Directories left behind without `state.vscdb`. Hidden until empty storage is shown. */
  private incompleteNodes(userDir: string): ManagedNode[] {
    return listIncompleteWorkspaceDirs(userDir).map((storageId) => {
      const workspace = {
        storageRoot: userDir,
        storageId,
        workspaceDbPath: path.join(
          userDir,
          'User',
          'workspaceStorage',
          storageId,
          'state.vscdb',
        ),
        globalDbPath: path.join(
          userDir,
          'User',
          'globalStorage',
          'state.vscdb',
        ),
        mtime: 0,
        key: `incomplete:${storageId}`,
      };

      const node: ManagedNode = {
        workspace,
        error: 'Incomplete workspace storage',
      };

      this.results.set(this.key(node), {
        key: workspaceStatisticsKey(workspace),
        detail: 'Incomplete workspace storage',
        hide: true,
        failed: true,
      });

      return node;
    });
  }

  /** Stable identity for a workspace row or one of its chats. */
  /** Tree row being acted on. */
  private key(node: ManagedNode): string {
    return JSON.stringify([
      workspaceStatisticsKey(node.workspace),
      node.chat?.composerId,
    ]);
  }

  /** Label, icon, and tooltip for one workspace, chat, or error row. */
  getTreeItem(node: ManagedNode): vscode.TreeItem {
    const presentation = workspacePresentation(node.workspace);

    const item = new vscode.TreeItem(
      node.error === 'Incomplete workspace storage'
        ? 'Incomplete workspace storage'
        : node.error
          ? 'Unable to load chats'
          : node.chat?.name ||
            (node.chat ? 'Untitled chat' : presentation.name),
      node.chat || node.error
        ? vscode.TreeItemCollapsibleState.None
        : vscode.TreeItemCollapsibleState.Collapsed,
    );

    const current = this.isCurrentRoot(node);

    if (!node.error && !current)
      item.checkboxState = this.selection.has(node)
        ? vscode.TreeItemCheckboxState.Checked
        : vscode.TreeItemCheckboxState.Unchecked;
    item.id = this.key(node) + (node.error ? ':error' : '');

    item.contextValue = node.error
      ? 'unavailable'
      : current
        ? 'managedCurrentWorkspace'
        : node.chat
          ? 'managedChat'
          : 'managedWorkspace';

    item.iconPath = new vscode.ThemeIcon(
      node.error ? 'warning' : node.chat ? 'comment-discussion' : 'folder',
    );

    const result = this.results.get(this.key(node));

    const workspaceSelected = !node.chat && this.selection.has(node);

    item.description =
      node.error ||
      (node.chat
        ? result?.detail || 'Not checked'
        : [
            current ? 'Current window' : undefined,
            workspaceSelected ? 'Workspace data selected' : result?.detail,
            presentation.location,
            node.workspace.storageId.slice(0, 8),
          ]
            .filter(Boolean)
            .join(' · '));

    item.tooltip = [
      node.chat?.name || presentation.name,
      presentation.path,
      `Storage: ${node.workspace.workspaceDbPath}`,
      node.chat ? `Chat: ${node.chat.composerId}` : '',
      current
        ? 'This workspace is open in the current window. Its chats can be deleted; its workspace data cannot.'
        : workspaceSelected
          ? 'Workspace data selected. Project files are kept.'
          : result?.detail ||
            node.error ||
            'Choose Check to inspect the available data.',
    ]
      .filter(Boolean)
      .join('\n');

    item.accessibilityInformation = {
      label: `${typeof item.label === 'string' ? item.label : presentation.name}. ${item.description}`,
    };

    return item;
  }

  /** List workspaces, or the chats of one workspace. */
  async getChildren(node?: ManagedNode): Promise<ManagedNode[]> {
    if (!node) {
      this.roots ??= this.loadWorkspaces(this.loading.signal);

      const roots = await this.roots;

      return this.showAll ||
        !roots.some(
          (
            /** Directory that contains the extracted or staged archive. */
            root,
          ) =>
            this.results.get(this.key(root))?.failed ||
            this.results.get(this.key(root))?.hide,
        )
        ? roots
        : roots.filter(
            (
              /** Directory that contains the extracted or staged archive. */
              root,
            ) =>
              !(
                this.results.get(this.key(root))?.failed ||
                this.results.get(this.key(root))?.hide
              ),
          );
    }

    if (node.chat || node.error) return [];
    const key = workspaceStatisticsKey(node.workspace);
    let pending = this.lists.get(key);

    if (!pending) {
      pending = this.loadChats(node.workspace, this.loading.signal);
      this.lists.set(key, pending);
    }

    return pending;
  }

  /** Read chat headers for one workspace. A failure becomes one error row. */
  private async loadChats(
    /** Workspace whose chat headers are read. */
    workspace: WorkspaceEntry,
    /** Cancellation for this tree load. */
    signal: AbortSignal,
  ): Promise<ManagedNode[]> {
    const log = startOperationLog(this.operations, 'load managed chats');

    try {
      const sqlite = await prepareSqlite(this.context);

      /** Headers returned by the list. */
      const result = await runTransfer<{
        /** Headers returned by the list-chats job. */
        allComposers: ComposerHeader[];
      }>(
        {
          kind: 'list-chats',
          ...sqlite,
          ...transferSettings(),
          workspace,
          filePath: '',
        },
        { signal, onEvent: log.event, onNote: log.note },
      );

      log.finish('completed');

      return orderedChatHeaders(result.allComposers).map((chat) => ({
        workspace,
        chat,
      }));
    } catch (error) {
      log.finish(signal.aborted ? 'cancelled' : 'failed', undefined, error);

      return [
        {
          workspace,
          error:
            error instanceof Error
              ? error.message
              : 'Read failed — see operation log',
        },
      ];
    }
  }

  /** Keep readable storage, including empty storage, with a shared header cache. */
  private async loadWorkspaces(
    /** Cancellation for the shared workspace scan. */
    signal: AbortSignal,
  ): Promise<ManagedNode[]> {
    const host = listHostEntries();

    const entries = workspacePickItems(
      host.entries,
      host.identity,
      currentWorkspaceDatabase(this.context),
    ).map((row) => row.entry);

    this.operationMessage = 'Preparing workspace list…';
    this.publishMessage();

    const log = startOperationLog(
      this.operations,
      'prepare managed workspaces',
    );

    const hidden = new Set<string>();
    const rows = new Map<string, StatisticsUpdate>();

    try {
      const sqlite = await prepareSqlite(this.context);

      /** How many items failed. */
      const result = await runTransfer<{
        /** How many checks failed. */
        failed: number;
      }>(
        {
          kind: 'workspace-statistics',
          ...sqlite,
          ...transferSettings(),
          workspaces: entries,
          deepCheck: true,
        },
        {
          signal,
          onEvent: log.event,
          onNote: log.note,
          onStatistics: (row) => {
            rows.set(row.key, row);
            if (row.failed || row.hide) hidden.add(row.key);
          },
        },
      );

      signal.throwIfAborted();

      for (const workspace of entries) {
        const row = rows.get(workspaceStatisticsKey(workspace));

        if (row) this.results.set(this.key({ workspace }), row);
      }

      log.fact(
        `Workspace list ready: ${entries.length - hidden.size} shown · ${hidden.size} empty or unavailable hidden`,
      );

      log.finish(result.failed ? 'incomplete' : 'completed');

      this.operationMessage = undefined;

      this.filterSummary = entries.length
        ? `${entries.length - hidden.size} workspaces · ${hidden.size} empty or unavailable filtered. Select workspace data or individual chats. Project files are kept.`
        : 'No local workspace data found.';

      this.publishMessage();

      return [
        ...entries.map((workspace) => ({ workspace })),
        ...this.incompleteNodes(host.userDir),
      ];
    } catch (error) {
      log.finish(signal.aborted ? 'cancelled' : 'failed', undefined, error);
      this.operationMessage = undefined;

      if (!signal.aborted) {
        this.filterSummary =
          'Workspace check unavailable. All entries shown; see the operation log.';

        this.publishMessage();
      }

      // A failed scan cannot prove that any workspace is disposable.
      return signal.aborted
        ? []
        : [
            ...entries.map((workspace) => ({ workspace })),
            ...this.incompleteNodes(host.userDir),
          ];
    }
  }

  /** Tree reveal needs an actual root row, not a synthetic command item. */
  async getParent(node: ManagedNode): Promise<ManagedNode | undefined> {
    if (!node.chat && !node.error) return undefined;

    return (await this.getChildren()).find(
      (/** Directory that contains the extracted or staged archive. */ root) =>
        workspaceStatisticsKey(root.workspace) ===
        workspaceStatisticsKey(node.workspace),
    );
  }

  /** Search includes collapsed workspaces; loaded header lists are reused by tree expansion. */
  async find(reveal: (node: ManagedNode) => PromiseLike<void>): Promise<void> {
    if (this.searching) return this.searching;

    this.searching = this.openSearch(reveal).finally(() => {
      this.searching = undefined;
    });

    return this.searching;
  }

  /** Own only the search UI; it never holds the transfer lock. */
  private async openSearch(
    reveal: (node: ManagedNode) => PromiseLike<void>,
  ): Promise<void> {
    const generation = this.loading.signal;

    const selected = await showManagedSearch({
      picker: vscode.window.createQuickPick(),
      onError: (error) =>
        this.operations.error(
          `Search failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      load: async (
        /** Cancellation for this search. */
        searchSignal,
        /** Append the next batch of search rows. */
        append,
      ) => {
        const signal = AbortSignal.any([generation, searchSignal]);
        const roots = await this.getChildren();

        signal.throwIfAborted();
        const pending: WorkspaceEntry[] = [];

        const rank = new Map(
          roots.map(
            (
              /** Directory that contains the extracted or staged archive. */
              root,
              index,
            ) => [workspaceStatisticsKey(root.workspace), index],
          ),
        );

        // Cached headers are small and avoid a second read on repeated searches.
        for (const root of roots) {
          const cached = this.lists.get(workspaceStatisticsKey(root.workspace));

          if (cached) {
            const nodes = await cached;

            signal.throwIfAborted();
            if (nodes.some((node) => node.error)) pending.push(root.workspace);
            else
              append(
                managedSearchItems(
                  root.workspace,
                  nodes.flatMap((node) => (node.chat ? [node.chat] : [])),
                  undefined,
                  rank.get(workspaceStatisticsKey(root.workspace)),
                ),
              );
          } else pending.push(root.workspace);
        }

        if (!pending.length) return { failed: 0 };
        const log = startOperationLog(this.operations, 'search managed chats');

        try {
          /** How many items failed. */
          const result = await runTransfer<{
            /** How many checks failed. */
            failed: number;
          }>(
            {
              kind: 'workspace-catalogue',
              ...(await prepareSqlite(this.context)),
              ...transferSettings(),
              workspaces: pending,
            },
            {
              signal,
              onEvent: log.event,
              onNote: log.note,
              onCatalogue: (row) => {
                if (signal.aborted) return;
                const workspace = pending[row.index];

                if (!workspace) return;
                const headers = orderedChatHeaders(row.headers || []);

                if (!row.error)
                  this.lists.set(
                    workspaceStatisticsKey(workspace),
                    Promise.resolve(
                      headers.map((chat) => ({
                        workspace,
                        chat,
                      })),
                    ),
                  );

                append(
                  managedSearchItems(
                    workspace,
                    headers,
                    row.error,
                    rank.get(workspaceStatisticsKey(workspace)),
                  ),
                );
              },
            },
          );

          log.finish(result.failed ? 'incomplete' : 'completed');

          return result;
        } catch (error) {
          log.finish(signal.aborted ? 'cancelled' : 'failed', undefined, error);

          throw error;
        }
      },
    });

    if (selected && !generation.aborted) await reveal(selected);
  }

  /** Inspect source data; publish batched tree updates without coupling jobs to focus. */
  async check(node?: ManagedNode): Promise<void> {
    await this.checkNodes(node ? [node] : []);
  }

  /** Batch repainting is shared by row checks and bulk checks. */
  private async checkNodes(nodes: ManagedNode[]): Promise<void> {
    const generation = this.loading.signal;

    await checkManagedNodes(
      this.context,
      this.operations,
      nodes,
      (item, row) => {
        if (generation.aborted) return;
        this.results.set(this.key(item), row);

        this.repaint ??= setTimeout(() => {
          this.repaint = undefined;
          this.changed.fire(undefined);
        }, 200);
      },
    );
  }
}

/** Keep management inside the existing container and use familiar native actions. */
export function registerManager(
  /** Extension host context that owns the tree view. */
  context: vscode.ExtensionContext,
  /** Operation log for manage, check, and recovery. */
  operations: TransitLog,
): void {
  const manager = new ChatManager(context, operations, (message) => {
    view.message = message;
  });

  const view = vscode.window.createTreeView('cursorChatTransit.manage', {
    treeDataProvider: manager,
    showCollapseAll: false,
    canSelectMany: false,
    manageCheckboxStateManually: true,
  });

  view.message =
    'Select workspace data or individual chats. Project files are kept.';

  // Row focus and context-menu focus are native UI state, not bulk selection.
  // Separate menu labels expose the scope; handlers recheck it at invocation time.
  let hadCheckedItems: boolean | undefined;

  /** Publish whether any managed row is checked. */
  const updateCheckedContext = () => {
    const hasCheckedItems = manager.selection.values().length > 0;

    if (hasCheckedItems === hadCheckedItems) return;
    hadCheckedItems = hasCheckedItems;

    void vscode.commands.executeCommand(
      'setContext',
      'cursorChatTransit.manageHasCheckedItems',
      hasCheckedItems,
    );
  };

  updateCheckedContext();

  context.subscriptions.push(
    manager.onDidChangeTreeData(updateCheckedContext),
    manager,
    view,
    view.onDidChangeCheckboxState((event) => {
      void (async () => {
        for (const [node, value] of event.items)
          await manager.select(
            node,
            value === vscode.TreeItemCheckboxState.Checked,
          );
      })().catch((error) => showFail('Update selection', error, operations));
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        [
          'userDataDir',
          'sqlitePath',
          'plansDirectory',
          'sqlite.operationTimeoutSeconds',
          'sqlite.busyTimeoutSeconds',
        ].some((key) => event.affectsConfiguration(`cursorChatTransit.${key}`))
      )
        manager.refresh();
    }),
  );

  const actions: Record<string, (node?: ManagedNode) => void | Promise<void>> =
    {
      manageSearch: () =>
        manager.find((node) =>
          view.reveal(node, { select: true, focus: true, expand: true }),
        ),
      manageRefresh: () => manager.refresh(),
      manageCheck: (node) => manager.check(node || view.selection[0]),
      manageSelectAll: () => manager.selectAll(),
      manageSelectEmpty: async () => {
        const first = await manager.selectEmpty();

        if (first)
          await view.reveal(first, {
            select: false,
            focus: false,
            expand: false,
          });
      },
      manageClearSelection: () => manager.clearSelection(),
      manageShowAll: () => manager.toggleVisibility(),
      manageShowRemovable: () => manager.toggleVisibility(),
      manageCheckSelected: () => manager.checkSelected(),
      // Title actions can receive host context; bulk deletion ignores every argument.
      manageDelete: () => manager.deleteSelected(),
      manageDeleteItem: (node) => manager.deleteSelected(node),
      manageDeleteWorkspaceData: (node) => manager.deleteSelected(node),
    };

  for (const [name, action] of Object.entries(actions))
    context.subscriptions.push(
      vscode.commands.registerCommand(
        `cursorChatTransit.${name}`,
        (node?: ManagedNode) =>
          Promise.resolve()
            .then(() => action(node))
            .catch((error) => showFail('Manage chats', error, operations)),
      ),
    );
}
