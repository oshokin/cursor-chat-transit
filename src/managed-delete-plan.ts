import type {
  ManagedDeletePlan,
  ManagedDeleteRequest,
  ManagedDeleteResult,
  ManagedPlanTarget,
} from './deletion-types';
import type { ManagedNode } from './managed-node';
import { groupManagedNodes } from './managed-selection';
import { sameDatabaseToken } from './workspace-removal';

/**
 * Keep workspace scope distinct from chat scope.
 * Checking every child does not become workspace deletion.
 */
export function requestsFromNodes(
  nodes: ManagedNode[],
): ManagedDeleteRequest[] {
  return groupManagedNodes(nodes).map((group) => {
    if (group.chats)
      return {
        kind: 'chats' as const,
        workspace: group.workspace,
        ids: group.chats.map((chat) => chat.composerId),
      };

    const root = nodes.find(
      (node) =>
        !node.chat &&
        !node.error &&
        node.workspace.workspaceDbPath === group.workspace.workspaceDbPath &&
        node.workspace.globalDbPath === group.workspace.globalDbPath,
    );

    return {
      kind: 'workspace-data' as const,
      workspace: group.workspace,
      ...(root?.requireEmpty ? { requireEmpty: true as const } : {}),
    };
  });
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

  if (
    workspaces.length > 0 &&
    !chats.length &&
    workspaces.every((target) => target.requireEmpty)
  ) {
    const shells = workspaces.reduce(
      (sum, target) => sum + target.ids.length,
      0,
    );

    const lines = workspaces
      .slice(0, 20)
      .map(
        (target) =>
          `• ${target.name} — ${target.location} — storage ${storageLabel(target.workspace.storageId, ids)}`,
      )
      .join('\n');

    const more =
      workspaces.length > 20 ? `\nAnd ${workspaces.length - 20} more.` : '';

    const shellLine = shells
      ? `\n\n${shells} empty chat record${shells === 1 ? '' : 's'} will also be removed.`
      : '';

    return {
      title: `Delete data for ${workspaces.length} workspace${workspaces.length === 1 ? '' : 's'} with no chat history?`,
      confirm: 'Delete workspace data',
      detail: `This permanently deletes their saved Cursor state, including workspace-local resources and extension data. Project files are kept.\n\nNo chat history was found in the supported data checked for these workspaces.${shellLine}\n\n${lines}${more}\n\nClose all other Cursor windows and stop Agent tasks before continuing. Do not use chats during deletion. Quit and reopen Cursor afterward.\n\nThis cannot be undone. Make your own backup first if you need this data.`,
    };
  }

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

  const chatSection = individual
    ? `\n\nIndividual chats:\n${chatLines.slice(0, Math.max(0, 20 - workspaceLines.length)).join('\n')}`
    : '';

  return {
    title: individual
      ? `Delete data for ${workspaces.length} workspace${workspaces.length === 1 ? '' : 's'} and ${individual} individual chat${individual === 1 ? '' : 's'}?`
      : `Delete data for ${workspaces.length} workspace${workspaces.length === 1 ? '' : 's'}?`,
    confirm: 'Delete selected data',
    detail: `Saved Cursor state, local resources and extension data will be deleted for the ${workspaces.length} selected workspace${workspaces.length === 1 ? '' : 's'}.\n\nWorkspace data:\n${workspaceLines.slice(0, 20).join('\n')}${chatSection}${more}\n\nProject files are kept. Close all other Cursor windows and stop Agent tasks. Do not use chats during deletion. Quit and reopen Cursor afterward.\n\nThis cannot be undone. Make your own backup first if you need this data.`,
  };
}

/** Operations status that matches the same outcome the notification shows. */
export function managedResultStatus(
  result: ManagedDeleteResult,
): 'completed' | 'partial' | 'failed' | 'cancelled' | 'incomplete' {
  if (result.uncertain) return 'partial';
  if (result.cancelled) return 'cancelled';

  const deleted = result.outcomes.some(
    (outcome) =>
      outcome.chatIdsDeleted.length > 0 ||
      outcome.storage === 'deleted' ||
      outcome.storage === 'partial',
  );

  const skipped = result.outcomes.some(
    (outcome) => outcome.chatIdsSkipped.length > 0,
  );

  const bad = result.outcomes.some(
    (outcome) =>
      !!outcome.errorMessage ||
      outcome.storage === 'unknown' ||
      outcome.storage === 'failed' ||
      outcome.storage === 'partial' ||
      outcome.storage === 'not-started',
  );

  if (result.error || bad) return deleted ? 'partial' : 'failed';
  if (skipped) return deleted ? 'partial' : 'incomplete';

  return 'completed';
}

/** User-facing result. Unknown and failed work are not described as deleted. */
export function describeManagedResult(result: ManagedDeleteResult): string {
  if (result.uncertain)
    return 'Deletion stopped. The final result is unknown. Quit and reopen Cursor, then check the selected workspace before retrying.';

  const deletedChats = result.outcomes.reduce(
    (sum, outcome) => sum + outcome.chatIdsDeleted.length,
    0,
  );

  const skipped = result.outcomes.reduce(
    (sum, outcome) => sum + outcome.chatIdsSkipped.length,
    0,
  );

  const deletedWorkspaces = result.outcomes.filter(
    (outcome) => outcome.storage === 'deleted',
  );

  const unknown = result.outcomes.filter(
    (outcome) => outcome.storage === 'unknown',
  );

  const unfinished = result.outcomes.filter(
    (outcome) => outcome.storage === 'partial' || outcome.storage === 'failed',
  );

  const pending = result.outcomes.filter(
    (outcome) => outcome.storage === 'not-started',
  );

  const skippedNote = skipped
    ? `${skipped} chat${skipped === 1 ? '' : 's'} skipped. `
    : '';

  if (result.cancelled)
    return `${skippedNote}Deletion cancelled. ${deletedWorkspaces.length} workspace${deletedWorkspaces.length === 1 ? '' : 's'} and ${deletedChats} chat${deletedChats === 1 ? '' : 's'} were already deleted; ${pending.length} workspace${pending.length === 1 ? '' : 's'} were not processed.`;

  if (
    !deletedWorkspaces.length &&
    !deletedChats &&
    unknown.length &&
    !unfinished.length
  )
    return (
      unknown[0]?.errorMessage ||
      'Workspace data was already gone. Nothing was deleted by this operation.'
    );

  if (
    !deletedWorkspaces.length &&
    !deletedChats &&
    (result.error || result.outcomes.some((outcome) => outcome.errorMessage))
  )
    return `Deletion stopped. ${result.error || result.outcomes.find((outcome) => outcome.errorMessage)?.errorMessage || 'Nothing was deleted.'}`;

  if (unfinished.length || pending.length || unknown.length) {
    const name =
      unfinished[0]?.label ||
      unknown[0]?.label ||
      pending[0]?.label ||
      'a workspace';

    return `${skippedNote}${deletedChats} chat${deletedChats === 1 ? '' : 's'} deleted. Workspace data removal did not finish for “${name}”. ${pending.length} workspace${pending.length === 1 ? ' was' : 's were'} not processed. See Operations.`;
  }

  if (deletedWorkspaces.length && deletedChats === 0)
    return deletedWorkspaces.length === 1
      ? `Deleted data for “${deletedWorkspaces[0].label}”. No chat records were deleted. Project files were kept.`
      : `Deleted data for ${deletedWorkspaces.length} workspaces. No chat records were deleted. Project files were kept.`;

  return `${skippedNote}Deleted data for ${deletedWorkspaces.length} workspace${deletedWorkspaces.length === 1 ? '' : 's'} and ${deletedChats} chat${deletedChats === 1 ? '' : 's'}. Project files were kept. Quit and reopen Cursor.`;
}

/** True when a freshly read target is still the confirmed one. */
export function planTargetMatches(
  confirmed: ManagedPlanTarget,
  ids: string[],
  token: string,
): boolean {
  const left = [...confirmed.ids].sort().join('\n');
  const right = [...ids].sort().join('\n');

  return left === right && sameDatabaseToken(confirmed.token, token);
}
