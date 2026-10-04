import type * as vscode from 'vscode';
import type { ManagedNode } from './managed-node';
import { chatPickItems } from './picker';
import { workspacePresentation } from './workspace-presentation';
import { workspaceStatisticsKey } from './statistics';
import type { ComposerHeader, WorkspaceEntry } from './types';

/** Native search results carry metadata and a reveal target only. */
export interface ManagedSearchItem extends vscode.QuickPickItem {
  /** Physical identity, stable across incremental list updates. */
  key: string;
  /** Stable presentation order, including workspaces loaded out of order from cache. */
  workspaceOrder: number;
  /** Workspace first, then its chats in the shared chat order. */
  chatOrder: number;
  /** Row to reveal in Manage chats. */
  node: ManagedNode;
}

/** Search workspace names/paths and chat titles without scanning message bodies. */
export function managedSearchItems(
  /** Workspace the chats belong to. */
  workspace: WorkspaceEntry,
  /** Headers already loaded for that workspace. */
  headers: ComposerHeader[],
  /** Load failure shown on every row for this workspace. */
  error?: string,
  /** Position of this workspace among the open ones. */
  workspaceOrder = 0,
): ManagedSearchItem[] {
  const place = workspacePresentation(workspace);
  const key = workspaceStatisticsKey(workspace);

  const byId = new Map(headers.map((chat) => [chat.composerId, chat]));

  return [
    {
      key,
      workspaceOrder,
      chatOrder: 0,
      label: place.name,
      description: `Workspace · ${place.location}`,
      detail: [place.path, `Storage ${workspace.storageId}`, error]
        .filter(Boolean)
        .join(' · '),
      node: { workspace },
    },
    ...chatPickItems(headers).map((row, index) => ({
      workspaceOrder,
      chatOrder: index + 1,
      key: JSON.stringify([key, row.id]),
      label: row.label,
      description: `Chat · ${place.name} · ${row.description}`,
      detail: `${place.path} · ${place.location} · Storage ${workspace.storageId}`,
      node: { workspace, chat: byId.get(row.id)! },
    })),
  ];
}

/** Incremental QuickPick with native filtering and explicit cancellation; focus changes do not close it. */
export function showManagedSearch(options: {
  /** Native host surface, injectable for lifecycle tests. */
  picker: vscode.QuickPick<ManagedSearchItem>;
  /** Append workspace groups in presentation order; shared readers stay in a worker. */
  load: (
    /** Cancellation for the catalogue read. */
    signal: AbortSignal,
    append: (/** Rows already loaded. */ rows: ManagedSearchItem[]) => void,
  ) => Promise<{
    /** Workspaces whose headers could not be read. */
    failed: number;
  }>;
  /** Log infrastructure failures; partial results stay visible. */
  onError: (error: unknown) => void;
}): Promise<ManagedNode | undefined> {
  const { picker } = options;
  const abort = new AbortController();
  const rows: ManagedSearchItem[] = [];
  let closed = false;
  let selected: ManagedNode | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  picker.title = 'Find chats and workspaces';
  picker.placeholder = 'Search workspace names, paths, and chat titles';
  picker.ignoreFocusOut = true;
  picker.matchOnDescription = true;
  picker.matchOnDetail = true;
  picker.keepScrollPosition = true;
  picker.busy = true;

  /** Refresh the pick list without dropping the active row. */
  const render = () => {
    clearTimeout(timer);
    timer = undefined;
    if (closed) return;
    const active = picker.activeItems[0]?.key;

    picker.items = [...rows].sort(
      (a, b) =>
        a.workspaceOrder - b.workspaceOrder || a.chatOrder - b.chatOrder,
    );

    if (active) picker.activeItems = rows.filter((row) => row.key === active);
  };

  return new Promise((resolve) => {
    const loading = Promise.resolve()
      .then(() =>
        options.load(abort.signal, (batch) => {
          if (closed || abort.signal.aborted) return;
          for (const row of batch) rows.push(row);
          timer ??= setTimeout(render, 100);
        }),
      )
      .then(
        (
          /** Search load failure, when the batch did not finish. */
          { failed },
        ) => {
          if (!closed)
            picker.title = `Find chats and workspaces${failed ? ` — ${failed} ${failed === 1 ? 'workspace' : 'workspaces'} unavailable` : ''}`;
        },
      )
      .catch((error: unknown) => {
        if (closed || abort.signal.aborted) return;
        picker.title = 'Search incomplete — see operation log';
        options.onError(error);
      })
      .finally(() => {
        render();
        if (!closed) picker.busy = false;
      });

    const subscriptions = [
      picker.onDidAccept(() => {
        if (!picker.selectedItems[0]) return;
        selected = picker.selectedItems[0].node;
        picker.hide();
      }),
      picker.onDidHide(() => {
        if (closed) return;
        closed = true;
        abort.abort();
        clearTimeout(timer);
        for (const subscription of subscriptions) subscription.dispose();
        picker.dispose();
        // Release the worker before revealing a row that could trigger another read.
        void loading.then(() => resolve(selected));
      }),
    ];

    picker.show();
  });
}
