import * as vscode from 'vscode';
import type { DeleteTarget } from './deletion-types';
import { showFail } from './extension-errors';
import { checkManagedNodes } from './extension-managed-check';
import { deleteManagedChats } from './extension-managed-delete';
import { transferSettings } from './extension-settings';
import {
  currentWorkspaceDatabase,
  listHostEntries,
  prepareSqlite,
} from './extension-workspaces';
import type { ManagedNode } from './managed-node';
import { managedSearchItems, showManagedSearch } from './managed-search';
import { ManagedSelection, groupManagedNodes } from './managed-selection';
import { startOperationLog } from './operation-log';
import type { TransitLog } from './output-ui';
import { orderedChatHeaders, workspacePickItems } from './picker';
import { workspaceStatisticsKey, type StatisticsUpdate } from './statistics';
import { runTransfer } from './transfer-process';
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

  /** Apply one checkbox change and update all affected rows. */
  async select(node: ManagedNode, checked: boolean): Promise<void> {
    const generation = this.loading.signal;
    const parent = { workspace: node.workspace };

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
    this.changed.fire(undefined);
  }
  /** Select visible workspace rows, including their collapsed chats. */
  async selectAll(): Promise<void> {
    this.selection.selectWorkspaces(await this.getChildren());
    this.changed.fire(undefined);
  }
  /** Clear hidden and visible selections alike. */
  clearSelection(): void {
    this.selection.clear();
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

    this.changed.fire(undefined);
  }
  /** Check the explicit selection through the existing checker. */
  async checkSelected(): Promise<void> {
    await this.checkNodes(this.selection.values());
  }

  /** Resolve checked scopes before row fallback; keyboard focus never changes deletion targets. */
  async deleteSelected(node?: ManagedNode): Promise<void> {
    const checked = this.selection.values();

    const selected = groupManagedNodes(
      checked.length ? checked : node ? [node] : [],
    );

    const targets: DeleteTarget[] = [];

    for (const item of selected) {
      const children: ManagedNode[] = item.chats
        ? item.chats.map((chat) => ({
            workspace: item.workspace,
            chat,
          }))
        : await this.getChildren({ workspace: item.workspace });

      if (children.some((/** Child tree node. */ child) => child.error))
        throw new Error(
          'A selected workspace could not be read. Nothing scheduled.',
        );

      targets.push({
        workspace: item.workspace,
        ids: children.flatMap((/** Child tree node. */ child) =>
          child.chat ? [child.chat.composerId] : [],
        ),
      });
    }

    if (await deleteManagedChats(this.context, this.operations, targets))
      this.refresh();
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
    this.loading.abort();
    clearTimeout(this.repaint);
    this.changed.dispose();
  }

  /** Drop cached chat lists and check results, then redraw. */
  refresh(): void {
    this.loading.abort();
    this.loading = new AbortController();
    this.roots = undefined;
    this.lists.clear();
    this.selection.clear();
    this.results.clear();
    this.changed.fire(undefined);
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
      node.error
        ? 'Unable to load chats'
        : node.chat?.name || (node.chat ? 'Untitled chat' : presentation.name),
      node.chat || node.error
        ? vscode.TreeItemCollapsibleState.None
        : vscode.TreeItemCollapsibleState.Collapsed,
    );

    if (!node.error)
      item.checkboxState = this.selection.has(node)
        ? vscode.TreeItemCheckboxState.Checked
        : vscode.TreeItemCheckboxState.Unchecked;
    item.id = this.key(node) + (node.error ? ':error' : '');

    item.contextValue = node.error
      ? 'unavailable'
      : node.chat
        ? 'managedChat'
        : 'managedWorkspace';

    item.iconPath = new vscode.ThemeIcon(
      node.error ? 'warning' : node.chat ? 'comment-discussion' : 'folder',
    );

    const result = this.results.get(this.key(node));

    item.description =
      node.error ||
      (node.chat
        ? result?.detail || 'Not checked'
        : [
            result?.detail,
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
      result?.detail ||
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

    this.listMessage('Preparing workspace list…');

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

      this.listMessage(
        `${entries.length - hidden.size} workspaces · ${hidden.size} empty or unavailable filtered. Use checkboxes to select history.`,
      );

      return entries.map((workspace) => ({
        workspace,
      }));
    } catch (error) {
      log.finish(signal.aborted ? 'cancelled' : 'failed', undefined, error);
      if (!signal.aborted)
        this.listMessage(
          'Workspace check unavailable. All entries shown; see the operation log.',
        );

      // A failed scan cannot prove that any workspace is disposable.
      return signal.aborted
        ? []
        : entries.map((workspace) => ({
            workspace,
          }));
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
    'Use checkboxes to select history. Delete acts on all checked items. Project files are kept.';

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
      manageClearSelection: () => manager.clearSelection(),
      manageShowAll: () => manager.toggleVisibility(),
      manageShowRemovable: () => manager.toggleVisibility(),
      manageCheckSelected: () => manager.checkSelected(),
      // Title actions can receive host context; bulk deletion ignores every argument.
      manageDelete: () => manager.deleteSelected(),
      manageDeleteItem: (node) => manager.deleteSelected(node),
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
