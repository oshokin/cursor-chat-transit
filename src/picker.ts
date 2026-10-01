import { workspaceKey } from './core';
import {
  chatActivityLabel,
  compareText,
  recentChats,
  validTimestamp,
} from './activity';
import {
  LOCATION_ORDER,
  workspaceLocation,
  workspacePresentation,
} from './workspace-presentation';
import type {
  ComposerHeader,
  WorkspaceEntry,
  WorkspaceIdentity,
} from './types';

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
  /** True when this row is the current window's workspace. */
  isCurrent: boolean;
}

/** Chat QuickPick row: title, activity, and the composer id. */
export interface ChatPickItem {
  /** Chat title. */
  label: string;
  /** Activity or creation date. */
  description: string;
  /** Secondary line; never an unconditional UUID dump. */
  detail: string;
  /** Composer id. */
  id: string;
  /** Whether the row starts selected. */
  picked: boolean;
}

/** QuickPick title for the workspace step. */
export function workspacePickTitle(action: WorkspacePickAction): string {
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

/** Native QuickPick rows for workspaceStorage entries. Current only when identity matches. */
export function workspacePickItems(
  entries: WorkspaceEntry[],
  current: WorkspaceIdentity | undefined,
): WorkspacePickItem[] {
  const currentKey = current ? workspaceKey(current.kind, current.uri) : null;

  const items = entries.map((entry) => {
    const isCurrent =
      !!currentKey &&
      !!entry.identity &&
      workspaceKey(entry.identity.kind, entry.identity.uri) === currentKey;

    const label = workspacePresentation(entry);

    return {
      label: label.name,
      description: isCurrent ? `Current · ${label.location}` : label.location,
      detail: label.path,
      entry,
      isCurrent,
    };
  });

  items.sort(
    (a, b) =>
      Number(b.isCurrent) - Number(a.isCurrent) ||
      LOCATION_ORDER[workspaceLocation(a.entry)] -
        LOCATION_ORDER[workspaceLocation(b.entry)] ||
      validTimestamp(b.entry.mtime) - validTimestamp(a.entry.mtime) ||
      a.label.localeCompare(b.label) ||
      compareText(a.entry.key, b.entry.key) ||
      compareText(a.entry.storageId, b.entry.storageId),
  );

  // Distinct storage entries can have the same human name/path (notably containers).
  // Add an identifier only for ambiguous rows; never merge their databases.
  disambiguateRows(
    items,
    (item) => item.entry.storageId,
    (item, id) => {
      item.detail += ` · Storage ${id}`;
    },
  );

  return items;
}

/** Most recently updated chats first. Untitled names stay last, still by recency. */
export function chatPickItems(composers: ComposerHeader[]): ChatPickItem[] {
  const ordered = recentChats(composers);

  const rows = [
    ...ordered.filter((composer) => hasChatTitle(composer.name)),
    ...ordered.filter((composer) => !hasChatTitle(composer.name)),
  ].map((composer) => {
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
  T extends { label: string; description: string; detail: string },
>(
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
