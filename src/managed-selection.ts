import type { ManagedNode } from './managed-node';
import { workspaceStatisticsKey } from './statistics';
import type { ComposerHeader, WorkspaceEntry } from './types';

/** Stable checkbox selection independent of focus, collapsed rows, and filters. */
export class ManagedSelection {
  /** Explicit workspace or chat scopes; exact IDs are resolved before confirmation. */
  private readonly items = new Map<string, ManagedNode>();
  /** Scope-qualified identity. */
  /** Tree row being acted on. */
  private key(node: ManagedNode): string {
    return JSON.stringify([
      workspaceStatisticsKey(node.workspace),
      node.chat?.composerId,
    ]);
  }
  /** Read selected nodes with children covered by a workspace removed. */
  values(): ManagedNode[] {
    return [...this.items.values()];
  }
  /** Clear the whole selection, including hidden items. */
  clear(): void {
    this.items.clear();
  }
  /** True for an explicit selection or a chat covered by its selected workspace. */
  has(node: ManagedNode): boolean {
    return (
      this.items.has(this.key(node)) ||
      (!!node.chat && this.items.has(this.key({ workspace: node.workspace })))
    );
  }
  /** Select workspace scopes in one pass instead of rescanning all selections per root. */
  selectWorkspaces(nodes: ManagedNode[]): void {
    const workspaces = nodes.filter((node) => !node.chat && !node.error);

    const keys = new Set(
      workspaces.map((node) => workspaceStatisticsKey(node.workspace)),
    );

    for (const [key, node] of this.items)
      if (keys.has(workspaceStatisticsKey(node.workspace)))
        this.items.delete(key);
    for (const node of workspaces) this.items.set(this.key(node), node);
  }
  /** Change an explicit checkbox; an excluded child removes the parent selection. */
  set(node: ManagedNode, checked: boolean): void {
    if (node.error) return;
    const parent = this.key({ workspace: node.workspace });

    if (!checked) {
      this.items.delete(this.key(node));
      if (node.chat) this.items.delete(parent);

      return;
    }

    if (node.chat && this.items.has(parent)) return;
    if (!node.chat)
      for (const [key, item] of this.items)
        if (
          workspaceStatisticsKey(item.workspace) ===
          workspaceStatisticsKey(node.workspace)
        )
          this.items.delete(key);
    this.items.set(this.key(node), node);
  }
}

/** Normalize a mixed selection once: parent workspace selections cover their children. */
export function groupManagedNodes(nodes: ManagedNode[]): {
  /** Workspace the selected rows belong to. */
  workspace: WorkspaceEntry;
  /** Selected chats. Omitted when the whole workspace is selected. */
  chats?: ComposerHeader[];
}[] {
  const groups = new Map<
    string,
    {
      /** Workspace the selected rows belong to. */
      workspace: WorkspaceEntry;
      /** Selected chats keyed by composer id. */
      chats?: Map<string, ComposerHeader>;
    }
  >();

  for (const node of nodes) {
    if (node.error) continue;
    const key = workspaceStatisticsKey(node.workspace);
    const existing = groups.get(key);

    if (!node.chat) groups.set(key, { workspace: node.workspace });
    else if (!existing || existing.chats) {
      const chats = existing?.chats || new Map<string, ComposerHeader>();

      chats.set(node.chat.composerId, node.chat);
      groups.set(key, { workspace: node.workspace, chats });
    }
  }

  return [...groups.values()].map((group) => ({
    workspace: group.workspace,
    chats: group.chats && [...group.chats.values()],
  }));
}
