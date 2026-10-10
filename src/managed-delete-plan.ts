import type {
  ManagedDeletePlan,
  ManagedDeleteRequest,
  ManagedDeleteResult,
  ManagedPlanTarget,
} from './deletion-types';
import type { ManagedNode } from './managed-node';
import { groupManagedNodes } from './managed-selection';

/**
 * Keep workspace scope distinct from chat scope.
 * Checking every child does not become workspace deletion.
 */
export function requestsFromNodes(
  nodes: ManagedNode[],
): ManagedDeleteRequest[] {
  return groupManagedNodes(nodes).map((group) =>
    group.chats
      ? {
          kind: 'chats' as const,
          workspace: group.workspace,
          ids: group.chats.map((chat) => chat.composerId),
        }
      : { kind: 'workspace-data' as const, workspace: group.workspace },
  );
}

/** One tree message. Chat counts do not include chats covered by a selected workspace. */
export function selectionSummary(
  nodes: ManagedNode[],
  hiddenWorkspaces = 0,
): string {
  if (!nodes.length)
    return 'Select workspace data or individual chats. Project files are kept.';
  const requests = requestsFromNodes(nodes);

  const workspaces = requests.filter(
    (request) => request.kind === 'workspace-data',
  ).length;

  const chats = requests.reduce(
    (sum, request) => sum + (request.kind === 'chats' ? request.ids.length : 0),
    0,
  );

  let text: string;

  if (workspaces && chats)
    text = `${workspaces} workspace${workspaces === 1 ? '' : 's'} + ${chats} individual chat${chats === 1 ? '' : 's'} selected`;
  else if (workspaces)
    text = `${workspaces} workspace${workspaces === 1 ? '' : 's'} selected · includes all their chats`;
  else
    text = `${chats} chat${chats === 1 ? '' : 's'} selected · workspace data is kept`;
  if (hiddenWorkspaces)
    text += ` · ${hiddenWorkspaces} selected workspace${hiddenWorkspaces === 1 ? ' is' : 's are'} hidden`;

  return text;
}

/** Short storage id when the prefix is unique among the ids shown together. */
export function storageLabel(id: string, all: string[]): string {
  if (id.length <= 8) return id;
  const prefix = id.slice(0, 8);

  return all.filter((item) => item.slice(0, 8) === prefix).length > 1
    ? id
    : `${prefix}…`;
}

/** Modal copy for a prepared plan. The confirm title must match exactly. */
export function confirmationCopy(plan: ManagedDeletePlan): {
  /** Warning title. */
  title: string;
  /** Warning detail. */
  detail: string;
  /** Destructive action title. */
  confirm: string;
} {
  const workspaces = plan.targets.filter(
    (target) => target.kind === 'workspace-data',
  );

  const chats = plan.targets.filter((target) => target.kind === 'chats');

  const total = plan.targets.reduce(
    (sum, target) => sum + target.ids.length,
    0,
  );

  const ids = workspaces.map((target) => target.workspace.storageId);

  if (workspaces.length === 1 && !chats.length) {
    const target = workspaces[0];
    const named = `“${target.name}”`;

    const lead =
      target.ids.length === 0
        ? 'This permanently deletes this workspace’s saved Cursor state, including local resources and extension data. No chat history was found in the supported indexes. Project files are kept.'
        : `This permanently deletes ${target.ids.length} chat${target.ids.length === 1 ? '' : 's'} and this workspace’s saved Cursor state, including local resources and extension data. Project files are kept.`;

    return {
      title: `Delete workspace data for ${named}?`,
      confirm: 'Delete workspace data',
      detail: `${lead}\n\nLocation: ${target.location} · ${target.pathLabel}\nStorage: ${storageLabel(target.workspace.storageId, ids)}\n\nClose all other Cursor windows and stop Agent tasks before continuing. Do not use chats during deletion. Quit and reopen Cursor afterward.\n\nThis cannot be undone. Make your own backup first if you need this data.`,
    };
  }

  const workspaceLines = workspaces.map(
    (target) =>
      `• ${target.name} — ${target.location} — ${target.ids.length} chat${target.ids.length === 1 ? '' : 's'} — storage ${storageLabel(target.workspace.storageId, ids)}`,
  );

  const chatLines = chats.map(
    (target) =>
      `• ${target.name} — ${target.ids.length} chat${target.ids.length === 1 ? '' : 's'}; workspace data is kept`,
  );

  if (!workspaces.length) {
    const lines = chats
      .slice(0, 20)
      .map(
        (target) =>
          `• ${target.name} — ${target.ids.length} chat${target.ids.length === 1 ? '' : 's'}; workspace data is kept`,
      )
      .join('\n');

    return {
      title: `Delete ${total} selected chat${total === 1 ? '' : 's'}?`,
      confirm: 'Delete chats',
      detail: `Workspace data is kept. Project files are kept.\n\n${lines}${chats.length > 20 ? `\nAnd ${chats.length - 20} more.` : ''}\n\nClose all other Cursor windows and stop Agent tasks. Do not use chats during deletion. Quit and reopen Cursor afterward.\n\nThis cannot be undone. Make your own backup first if you need this data.`,
    };
  }

  const individual = chats.reduce((sum, target) => sum + target.ids.length, 0);
  const hidden = workspaceLines.length + chatLines.length - 20;
  const more = hidden > 0 ? `\nAnd ${hidden} more.` : '';

  return {
    title: `Delete data for ${workspaces.length} workspace${workspaces.length === 1 ? '' : 's'} and ${individual} individual chat${individual === 1 ? '' : 's'}?`,
    confirm: 'Delete selected data',
    detail: `${total} chat${total === 1 ? '' : 's'} will be deleted in total. Saved Cursor state, local resources and extension data will also be deleted for the ${workspaces.length} selected workspace${workspaces.length === 1 ? '' : 's'}.\n\nWorkspace data:\n${workspaceLines.slice(0, 20).join('\n') || '• None'}\n\nIndividual chats:\n${chatLines.slice(0, Math.max(0, 20 - workspaceLines.length)).join('\n') || '• None'}${more}\n\nProject files are kept. Close all other Cursor windows and stop Agent tasks. Do not use chats during deletion. Quit and reopen Cursor afterward.\n\nThis cannot be undone. Make your own backup first if you need this data.`,
  };
}

/** User-facing result. Directory failure is not reported as a full undo. */
export function describeManagedResult(result: ManagedDeleteResult): string {
  if (result.uncertain)
    return 'Deletion stopped. The final result is unknown. Quit and reopen Cursor, then check the selected workspace before retrying.';

  const deletedChats = result.outcomes.reduce(
    (sum, outcome) => sum + outcome.chatIdsDeleted.length,
    0,
  );

  const deletedWorkspaces = result.outcomes.filter(
    (outcome) => outcome.storage === 'deleted',
  );

  const unfinished = result.outcomes.filter(
    (outcome) => outcome.storage === 'partial' || outcome.storage === 'failed',
  );

  const pending = result.outcomes.filter(
    (outcome) => outcome.storage === 'not-started',
  );

  if (result.cancelled)
    return `Deletion cancelled. ${deletedWorkspaces.length} workspace${deletedWorkspaces.length === 1 ? '' : 's'} and ${deletedChats} chat${deletedChats === 1 ? '' : 's'} were already deleted; ${pending.length} workspace${pending.length === 1 ? '' : 's'} were not processed.`;

  if (unfinished.length || pending.length) {
    const name = unfinished[0]?.label || pending[0]?.label || 'a workspace';

    return `${deletedChats} chat${deletedChats === 1 ? '' : 's'} deleted. Workspace data removal did not finish for “${name}”. ${pending.length} workspace${pending.length === 1 ? ' was' : 's were'} not processed. See Operations.`;
  }

  if (
    deletedWorkspaces.length === 1 &&
    deletedChats === 0 &&
    result.outcomes.length === 1
  )
    return `Deleted data for “${deletedWorkspaces[0].label}”. No chat records were deleted. Project files were kept.`;

  return `Deleted data for ${deletedWorkspaces.length} workspace${deletedWorkspaces.length === 1 ? '' : 's'} and ${deletedChats} chat${deletedChats === 1 ? '' : 's'}. Project files were kept. Quit and reopen Cursor.`;
}

/** True when a freshly read target is still the confirmed one. */
export function planTargetMatches(
  confirmed: ManagedPlanTarget,
  ids: string[],
  token: string,
): boolean {
  const left = [...confirmed.ids].sort().join('\n');
  const right = [...ids].sort().join('\n');

  return left === right && confirmed.token === token;
}
