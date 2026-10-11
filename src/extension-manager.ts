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
import {
  buildFamily,
  descendantCount,
  directChildren,
  keptParentNote,
  narrowDeletion,
  topLevelChats,
  type FamilyGraph,
} from './chat-family';
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
  /** Headers for one workspace, used to place subagents without another read. */
  private readonly headerCache = new Map<string, ComposerHeader[]>();
  /** Family links for those headers. */
  private readonly familyCache = new Map<string, FamilyGraph>();
  /** Workspace row order. Name is the default; Recent keeps the previous order. */
  private workspaceSort: 'name' | 'recent' = 'name';
  /** Sorted copy of one visible root array. The source inventory is not reordered. */
  private orderedRoots?: {
    source: ManagedNode[];
    value: ManagedNode[];
  };
  /** Cancels chat loads when the view is disposed. */
  private loading = new AbortController();
  /** True after dispose. Deletion cancel must not replace the controller. */
  private closed = false;
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

    if (!checked && node.chat && this.selection.has(parent)) {
      const siblings = await this.getChildren(parent);

      if (generation.aborted) return;
      if (siblings.some((item) => item.error))
        throw new Error(
          'Unable to update selection. Refresh the workspace and try again.',
        );

      const headers =
        this.headerCache.get(workspaceStatisticsKey(node.workspace)) || [];

      const excluded = new Set([
        node.chat.composerId,
        ...this.descendantHeaders(headers, node.chat.composerId).map(
          (header) => header.composerId,
        ),
      ]);

      this.selection.set(parent, false);

      const remainder = headers.length
        ? headers.map((chat) => ({ workspace: node.workspace, chat }))
        : siblings;

      for (const item of remainder) {
        const id = item.chat?.composerId;

        if (!id || excluded.has(id)) continue;
        this.selection.set(item, true);
      }
    } else {
      this.selection.set(node, checked);

      if (node.chat) {
        const headers =
          this.headerCache.get(workspaceStatisticsKey(node.workspace)) || [];

        for (const child of this.descendantHeaders(
          headers,
          node.chat.composerId,
        ))
          this.selection.set(
            { workspace: node.workspace, chat: child },
            checked,
          );
      }
    }

    this.publishMessage();
    this.changed.fire(undefined);
  }
  /** Select visible workspace rows that can be deleted. The current window is excluded. */
  async selectAll(): Promise<void> {
    this.operationMessage = undefined;
    const roots = await this.getChildren();

    this.selection.selectWorkspaces(roots);

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
    const pending = [
      ...this.lists.values(),
      ...(this.roots ? [this.roots] : []),
    ];

    this.loading.abort();
    await Promise.allSettled(pending);

    try {
      const checked = this.selection.values();

      const chosen = checked.length
        ? checked
        : node && !node.error
          ? [node]
          : [];

      const narrowed = this.withoutKeptParents(chosen);

      if (!chosen.length) {
        await deleteManagedChats(this.context, this.operations, []);

        return;
      }

      if (!narrowed.nodes.length) {
        this.operationMessage =
          narrowed.note || 'Select workspace data or individual chats.';

        this.publishMessage();

        return;
      }

      if (narrowed.note) this.operationMessage = narrowed.note;

      const requests = requestsFromNodes(narrowed.nodes).map((request) =>
        narrowed.note && request.kind === 'chats'
          ? { ...request, note: narrowed.note }
          : request,
      );

      if (await deleteManagedChats(this.context, this.operations, requests))
        this.refresh();
    } finally {
      if (!this.closed && this.loading.signal.aborted) {
        this.loading = new AbortController();
        this.lists.clear();
        this.roots = undefined;
      }
    }
  }

  /**
   * Replace the checked set with workspaces that have no supported chat history.
   * Hidden rows are included. A selection edit during the scan keeps the user's set.
   */
  async selectEmpty(): Promise<ManagedNode | undefined> {
    const generation = this.generation;
    const revision = this.selection.revision;
    const log = startOperationLog(this.operations, 'find empty workspaces');

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
                  onEvent: log.event,
                  onPhase: (phase, metrics) => {
                    const label =
                      phase === 'validate'
                        ? 'Checking whether deletion is allowed'
                        : 'Checking chat history';

                    const message =
                      typeof metrics?.total === 'number'
                        ? `${label}: ${metrics.processed || 0} of ${metrics.total}`
                        : label;

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
      log.finish(isAbort(error) ? 'cancelled' : 'failed', undefined, error);
      if (isAbort(error)) return undefined;

      throw error;
    }

    if (!scan) {
      this.operationMessage = undefined;
      this.publishMessage();
      log.finish('cancelled');

      return undefined;
    }

    log.fact(
      `candidates=${scan.candidates} selected=${scan.selected.length} unchecked=${scan.unchecked}`,
    );

    if (
      generation !== this.generation ||
      revision !== this.selection.revision
    ) {
      this.operationMessage =
        'Selection changed while checking. Run Select empty workspaces again.';

      this.publishMessage();
      log.finish('incomplete');

      return undefined;
    }

    if (!scan.selected.length) {
      this.operationMessage = scan.unchecked
        ? `No empty workspaces found. Selection unchanged. ${scan.unchecked} could not be checked.`
        : 'No empty workspaces found. Selection unchanged.';

      this.publishMessage();
      log.finish(scan.unchecked ? 'incomplete' : 'completed');

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
    log.finish(scan.unchecked ? 'incomplete' : 'completed');
    this.changed.fire(undefined);

    const first = scan.selected[0];

    return roots.find(
      (node) =>
        !node.chat &&
        node.workspace.workspaceDbPath === first.workspaceDbPath &&
        node.workspace.globalDbPath === first.globalDbPath,
    );
  }

  /**
   * Replace the checked set with chats whose transfer health is incomplete, missing, or empty.
   * Ready, unknown, and failed rows stay unchecked. A selection edit during the scan is kept.
   */
  async selectIssues(): Promise<ManagedNode | undefined> {
    const generation = this.generation;
    const revision = this.selection.revision;

    this.operationMessage = 'Finding chats with transfer issues…';
    this.publishMessage();
    this.roots ??= this.loadWorkspaces(this.loading.signal);
    const roots = await this.roots;
    const chats: ManagedNode[] = [];

    for (const root of roots) {
      if (root.error) continue;
      await this.getChildren(root);

      const headers =
        this.headerCache.get(workspaceStatisticsKey(root.workspace)) || [];

      for (const chat of headers)
        chats.push({ workspace: root.workspace, chat });
    }

    if (!chats.length) {
      this.operationMessage =
        'No chats with transfer issues. Selection unchanged.';

      this.publishMessage();

      return undefined;
    }

    const status = await checkManagedNodes(
      this.context,
      this.operations,
      chats,
      (node, row) => {
        this.results.set(this.key(node), row);
      },
      {
        title: 'Finding chats with transfer issues…',
        kind: 'find chats with transfer issues',
      },
    );

    if (status !== 'done') {
      this.operationMessage = undefined;
      this.publishMessage();

      return undefined;
    }

    if (
      generation !== this.generation ||
      revision !== this.selection.revision
    ) {
      this.operationMessage =
        'Selection changed while checking. Run the command again to apply the results.';

      this.publishMessage();

      return undefined;
    }

    const counts = { incomplete: 0, missing: 0, empty: 0, unchecked: 0 };
    const picked: ManagedNode[] = [];

    for (const chat of chats) {
      const row = this.results.get(this.key(chat));
      const health = row?.health;

      if (
        row?.failed ||
        !health ||
        health === 'unknown' ||
        health === 'ready'
      ) {
        if (row?.failed || !health || health === 'unknown')
          counts.unchecked += 1;

        continue;
      }

      if (
        health === 'incomplete' ||
        health === 'missing' ||
        health === 'empty'
      ) {
        counts[health] += 1;
        picked.push(chat);
      }
    }

    if (!picked.length) {
      this.operationMessage = counts.unchecked
        ? `No chats with transfer issues. Selection unchanged. ${counts.unchecked} could not be checked.`
        : 'No chats with transfer issues. Selection unchanged.';

      this.publishMessage();

      return undefined;
    }

    this.selection.clear();

    for (const chat of picked) this.selection.set(chat, true);
    this.operationMessage = issueSelectionMessage(counts);
    this.publishMessage();
    this.changed.fire(undefined);

    return picked[0];
  }

  /** Drop a selected parent when one of its subagents is not selected. */
  private withoutKeptParents(nodes: ManagedNode[]): {
    nodes: ManagedNode[];
    note?: string;
  } {
    const chats = nodes.filter((node) => node.chat);
    const roots = nodes.filter((node) => !node.chat);

    if (!chats.length) return { nodes };
    const kept: Array<{ unselected: number }> = [];
    const drop = new Set<string>();
    const groups = new Map<string, ManagedNode[]>();

    for (const chat of chats) {
      const key = chat.workspace.workspaceDbPath;
      const list = groups.get(key) || [];

      list.push(chat);
      groups.set(key, list);
    }

    for (const group of groups.values()) {
      const headers =
        this.headerCache.get(workspaceStatisticsKey(group[0].workspace)) ||
        group.map((node) => node.chat!);

      const narrowed = narrowDeletion(
        headers,
        group.map((node) => node.chat!.composerId),
      );

      for (const row of narrowed.kept) {
        drop.add(`${group[0].workspace.workspaceDbPath}\0${row.composerId}`);
        kept.push(row);
      }
    }

    const note = keptParentNote(kept);

    return {
      nodes: [
        ...roots,
        ...chats.filter(
          (node) =>
            !drop.has(
              `${node.workspace.workspaceDbPath}\0${node.chat!.composerId}`,
            ),
        ),
      ],
      ...(note ? { note } : {}),
    };
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
  ) {
    this.workspaceSort =
      context.globalState?.get('manageWorkspaceSort') === 'recent'
        ? 'recent'
        : 'name';
  }

  /** Stop loads and release the tree event. */
  dispose(): void {
    this.closed = true;
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
    this.headerCache.clear();
    this.familyCache.clear();
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

  /** Drop check labels after the property budget changes. Selection stays. */
  invalidateCheckResults(): void {
    this.results.clear();
    this.changed.fire(undefined);
  }

  /** Remember the workspace order without rereading Cursor. */
  sortWorkspaces(mode: 'name' | 'recent'): void {
    this.workspaceSort = mode;
    this.orderedRoots = undefined;
    void this.context.globalState.update('manageWorkspaceSort', mode);
    this.changed.fire(undefined);
  }

  /** Direct child headers already loaded for this chat. */
  private directChildHeaders(node: ManagedNode): ComposerHeader[] {
    if (!node.chat) return [];

    return directChildren(
      this.headerCache.get(workspaceStatisticsKey(node.workspace)) || [],
      node.chat.composerId,
    );
  }

  /** Confirmed descendants of one chat, not including the chat itself. */
  private descendantHeaders(
    headers: ComposerHeader[],
    composerId: string,
  ): ComposerHeader[] {
    const graph = buildFamily(headers);
    const out: ComposerHeader[] = [];
    const stack = [...(graph.nodes.get(composerId)?.childComposerIds || [])];
    const seen = new Set<string>();

    while (stack.length) {
      const id = stack.pop();

      if (!id || seen.has(id)) continue;
      seen.add(id);
      const header = headers.find((item) => item.composerId === id);

      if (header) out.push(header);

      for (const child of graph.nodes.get(id)?.childComposerIds || [])
        stack.push(child);
    }

    return out;
  }

  /** Subagent count or type shown beside a chat. */
  private familyDescription(node: ManagedNode): string {
    if (!node.chat) return '';
    const key = workspaceStatisticsKey(node.workspace);
    const graph = this.familyCache.get(key);
    const info = graph?.nodes.get(node.chat.composerId);

    if (!info || !graph) return '';
    if (info.relation === 'unresolved') return 'Parent unavailable';
    if (info.relation === 'child')
      return info.subagentTypeName
        ? subagentTypeLabel(info.subagentTypeName)
        : 'Subagent';
    const count = descendantCount(graph, node.chat.composerId);

    return count ? `${count} subagent${count === 1 ? '' : 's'}` : '';
  }

  /** Selected parent whose descendants are only partly checked. */
  private partialSelection(
    node: ManagedNode,
  ): { label: string; unselected: number } | undefined {
    if (!node.chat || !this.selection.has(node)) return undefined;

    const headers =
      this.headerCache.get(workspaceStatisticsKey(node.workspace)) || [];

    const descendants = this.descendantHeaders(headers, node.chat.composerId);

    if (!descendants.length) return undefined;

    const unselected = descendants.filter(
      (header) =>
        !this.selection.has({ workspace: node.workspace, chat: header }),
    ).length;

    if (!unselected) return undefined;
    const total = descendants.length + 1;

    return {
      label: `${total - unselected} of ${total} selected`,
      unselected,
    };
  }

  /** Name order is cached for one visible array. Recent keeps the loader order. */
  private orderRoots(visible: ManagedNode[]): ManagedNode[] {
    if (this.workspaceSort !== 'name') return visible;
    if (this.orderedRoots?.source === visible) return this.orderedRoots.value;

    const value = [...visible].sort((left, right) =>
      this.compareWorkspaces(left, right),
    );

    this.orderedRoots = { source: visible, value };

    return value;
  }

  /** Name order. The current window stays in its alphabetical place. */
  private compareWorkspaces(left: ManagedNode, right: ManagedNode): number {
    const a = workspacePresentation(left.workspace);
    const b = workspacePresentation(right.workspace);

    const name = new Intl.Collator(undefined, {
      numeric: true,
      sensitivity: 'base',
    }).compare(a.name, b.name);

    if (name) return name;

    const pathOrder = new Intl.Collator(undefined, {
      numeric: true,
      sensitivity: 'base',
    }).compare(a.path, b.path);

    if (pathOrder) return pathOrder;

    return left.workspace.workspaceDbPath < right.workspace.workspaceDbPath
      ? -1
      : left.workspace.workspaceDbPath > right.workspace.workspaceDbPath
        ? 1
        : 0;
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
      node.error
        ? vscode.TreeItemCollapsibleState.None
        : node.chat
          ? this.directChildHeaders(node).length
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None
          : vscode.TreeItemCollapsibleState.Collapsed,
    );

    const current = this.isCurrentRoot(node);

    if (!node.error)
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
        ? [
            result?.detail || 'Not checked',
            this.familyDescription(node),
            this.partialSelection(node)?.label,
          ]
            .filter(Boolean)
            .join(' · ')
        : [
            current ? 'Current window' : undefined,
            workspaceSelected ? 'Workspace data selected' : result?.detail,
            presentation.location,
            node.workspace.storageId.slice(0, 8),
          ]
            .filter(Boolean)
            .join(' · '));

    const partial = this.partialSelection(node);

    item.tooltip = [
      node.chat?.name || presentation.name,
      presentation.path,
      `Storage: ${node.workspace.workspaceDbPath}`,
      node.chat ? `Chat: ${node.chat.composerId}` : '',
      partial
        ? `This chat is selected; ${partial.unselected} subagent${partial.unselected === 1 ? ' is' : 's are'} not selected`
        : '',
      current
        ? 'Its chats can be selected and deleted. Workspace storage is kept while this window is open.'
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

      const visible =
        this.showAll ||
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

      return this.orderRoots(visible);
    }

    if (node.error) return [];

    if (node.chat) {
      const headers =
        this.headerCache.get(workspaceStatisticsKey(node.workspace)) || [];

      return directChildren(headers, node.chat.composerId).map((chat) => ({
        workspace: node.workspace,
        chat,
      }));
    }

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
      const ordered = orderedChatHeaders(result.allComposers);
      const key = workspaceStatisticsKey(workspace);

      this.headerCache.set(key, ordered);
      this.familyCache.set(key, buildFamily(ordered));

      return topLevelChats(ordered).map((chat) => ({
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

  /** Tree reveal needs the real parent row, not a synthetic command item. */
  async getParent(node: ManagedNode): Promise<ManagedNode | undefined> {
    if (!node.chat && !node.error) return undefined;

    const workspace = (await this.getChildren()).find(
      (root) =>
        workspaceStatisticsKey(root.workspace) ===
        workspaceStatisticsKey(node.workspace),
    );

    if (!node.chat || node.error || !workspace) return workspace;
    const key = workspaceStatisticsKey(node.workspace);

    const parentId = this.familyCache
      .get(key)
      ?.nodes.get(node.chat.composerId)?.parentComposerId;

    const parent = (this.headerCache.get(key) || []).find(
      (header) => header.composerId === parentId,
    );

    return parent ? { workspace: node.workspace, chat: parent } : workspace;
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

/** Display label for a stored subagent type. Unknown names stay as stored. */
function issueSelectionMessage(counts: {
  incomplete: number;
  missing: number;
  empty: number;
  unchecked: number;
}): string {
  const selected = counts.incomplete + counts.missing + counts.empty;

  const parts = [
    counts.incomplete ? `${counts.incomplete} incomplete` : '',
    counts.missing ? `${counts.missing} with no stored data` : '',
    counts.empty ? `${counts.empty} empty` : '',
  ].filter(Boolean);

  return `${selected} chat${selected === 1 ? '' : 's'} selected: ${parts.join(', ')}.${counts.unchecked ? ` ${counts.unchecked} could not be checked.` : ''}`;
}

function subagentTypeLabel(name: string): string {
  if (name === 'explore') return 'Explore';
  if (name === 'generalPurpose') return 'General purpose';
  if (name === 'shell') return 'Shell';

  return name;
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
      if (
        event.affectsConfiguration('cursorChatTransit.limits.maxJsonProperties')
      )
        manager.invalidateCheckResults();
    }),
  );

  const actions: Record<string, (node?: ManagedNode) => void | Promise<void>> =
    {
      manageSearch: () =>
        manager.find((node) =>
          view.reveal(node, { select: true, focus: true, expand: true }),
        ),
      manageRefresh: () => manager.refresh(),
      manageSortName: () => manager.sortWorkspaces('name'),
      manageSortRecent: () => manager.sortWorkspaces('recent'),
      manageCheck: (node) => manager.check(node || view.selection[0]),
      manageSelectAll: () => manager.selectAll(),
      manageSelectIssues: async () => {
        const first = await manager.selectIssues();

        if (first)
          await view.reveal(first, {
            select: false,
            focus: false,
            expand: false,
          });
      },
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
