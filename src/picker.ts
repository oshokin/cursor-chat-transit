import { chatActivityLabel, recentChats } from './activity';
import type {
  ComposerHeader,
  WorkspaceEntry,
  WorkspaceIdentity,
} from './types';
import { workspacePresentation } from './workspace-presentation';
import {
  currentWorkspaceGroupKey,
  orderWorkspaceEntries,
  sameDatabasePath,
  storageExplanation,
  storageMark,
  workspaceGroupKey,
} from './workspace-opening';

/** QuickPick action that chooses the workspace step title. */
export type WorkspacePickAction = 'export' | 'import' | 'select';

/** Workspace QuickPick row: labels plus the storage entry, never mutated in place. */
export interface WorkspacePickItem {
  /** Primary picker line. */
  label: string;
  /** Host or location line. */
  description: string;
  /** Path or extra identity line. */
  detail: string;
  /** Storage entry this row represents. */
  entry: WorkspaceEntry;
  /** True when this row is the current window's database. */
  isCurrent: boolean;
  /** True when this row belongs to the pinned current project group. */
  inCurrentGroup: boolean;
}

/** Chat QuickPick row: title, activity, and the composer id. */
export interface ChatPickItem {
  /** Chat title. */
  label: string;
  /** Activity or creation date. */
  description: string;
  /** Secondary line; never an unconditional UUID dump. */
  detail: string;
  id: string;
  /** Whether the row starts selected. */
  picked: boolean;
}

/** QuickPick title for the workspace step. */
export function workspacePickTitle(
  /** Which picker step is open. */
  action: WorkspacePickAction,
): string {
  if (action === 'select') return 'Choose workspace';

  return action === 'export'
    ? 'Export chats — choose source workspace'
    : 'Import chats — choose destination workspace';
}

/** QuickPick placeholder for the workspace step. */
export function workspacePickPlaceholder(): string {
  return 'Choose a workspace, then continue';
}

/** True when a header has a non-empty string title. `trim` is only a presence check. */
export function hasChatTitle(name: unknown): name is string {
  return typeof name === 'string' && !!name.trim();
}

/** Chat list label. Does not invent titles and must not be written back into export JSON. */
export function chatListLabel(name: unknown): string {
  return hasChatTitle(name) ? name : 'Untitled chat';
}

/**
 * Native QuickPick rows.
 * `Current window` is the physical database only. A URI match does not get that label.
 */
export function workspacePickItems(
  /** Entries to turn into picker rows. */
  entries: WorkspaceEntry[],
  /** Identity of the workspace that is open now. */
  current: WorkspaceIdentity | undefined,
  /** Database path of the workspace that is open now. */
  currentDatabase?: string,
): WorkspacePickItem[] {
  const ordered = orderWorkspaceEntries(entries, {
    mode: 'activity',
    current,
    currentDatabase,
  });

  const pinnedKey = currentWorkspaceGroupKey(entries, {
    current,
    currentDatabase,
  });

  const items = ordered.map((entry) => {
    const isCurrent = currentDatabase
      ? sameDatabasePath(entry.workspaceDbPath, currentDatabase)
      : false;

    const label = workspacePresentation(entry);
    const mark = storageMark(entry, isCurrent);

    return {
      label: label.name,
      description: [mark, label.location].filter(Boolean).join(' · '),
      detail: label.path,
      entry,
      isCurrent,
      inCurrentGroup: pinnedKey
        ? workspaceGroupKey(entry) === pinnedKey
        : false,
    };
  });

  // Distinct storage entries can have the same human name/path (notably containers).
  // Add an identifier only for ambiguous rows; never merge their databases.
  disambiguateRows(
    items,
    (item) => item.entry.storageId,
    (item, id) => {
      item.detail += ` · Storage ${id}`;
    },
  );

  for (const item of items) {
    const explanation = storageExplanation(item.entry, item.isCurrent);

    if (explanation) item.detail += `\n${explanation}`;
  }

  return items;
}

/** Shared order for native chat pickers, the management tree, and search. */
export function orderedChatHeaders(
  /** Composer bodies keyed by id. */
  composers: ComposerHeader[],
): ComposerHeader[] {
  const ordered = recentChats(composers);

  return [
    ...ordered.filter((chat) => hasChatTitle(chat.name)),
    ...ordered.filter((chat) => !hasChatTitle(chat.name)),
  ];
}

/** Most recently updated chats first. Untitled names stay last, still by recency. */
export function chatPickItems(
  /** Composer bodies keyed by id. */
  composers: ComposerHeader[],
): ChatPickItem[] {
  const rows = orderedChatHeaders(composers).map((composer) => {
    return {
      label: chatListLabel(composer.name),
      description: chatActivityLabel(composer),
      detail:
        typeof composer.subtitle === 'string'
          ? composer.subtitle.replace(/\s+/g, ' ').trim().slice(0, 120)
          : '',
      id: composer.composerId,
      picked: true,
    };
  });

  disambiguateRows(
    rows,
    (row) => row.id,
    (row, id) => {
      row.description += ` · ${id}`;
    },
  );

  return rows;
}

/** Add a short identity only inside groups that would otherwise look identical. */
function disambiguateRows<
  /** Name used when the value is rejected. */
  T extends {
    /** Row title. */
    label: string;
    /** Secondary line. */
    description: string;
    /** Third line. */
    detail: string;
  },
>(
  /** Rows already loaded. */
  rows: T[],
  idOf: (row: T) => string,
  annotate: (row: T, id: string) => void,
): void {
  const groups = new Map<string, T[]>();

  for (const row of rows) {
    const key = JSON.stringify([row.label, row.description, row.detail]);
    const group = groups.get(key) || [];

    group.push(row);
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const counts = new Map<string, number>();

    for (const row of group) {
      const prefix = idOf(row).slice(0, 8);

      counts.set(prefix, (counts.get(prefix) || 0) + 1);
    }

    for (const row of group) {
      const id = idOf(row);
      const prefix = id.slice(0, 8);

      annotate(row, counts.get(prefix) === 1 ? prefix : id);
    }
  }
}
