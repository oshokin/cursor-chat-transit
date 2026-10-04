import {
  matchesWorkspaceStorage,
  readGlobalHeaderSources,
  type HeaderSource,
} from './db-headers';
import type { DeleteTarget } from './deletion-types';
import type {
  ComposerHeader,
  Layout,
  SqliteConn,
  TransferContext,
  WorkspaceEntry,
} from './types';
import { WorkspaceHeaderReader } from './workspace-header-reader';

/** Read ownership once; retain only selected IDs, and fail closed on unreadable storage. */
export async function inspectDeletionOwnership(
  /** Transfer hooks, timeouts, and cancellation. */
  ctx: TransferContext,
  /** Workspaces whose chats may be deleted. */
  workspaces: WorkspaceEntry[],
  /** Chats selected for deletion. */
  targets: DeleteTarget[],
) {
  const reader = new WorkspaceHeaderReader(ctx);
  const selected = new Map<string, Set<string>>();

  for (const target of targets) {
    const ids =
      selected.get(target.workspace.globalDbPath) || new Set<string>();

    for (const id of target.ids) ids.add(id);
    selected.set(target.workspace.globalDbPath, ids);
  }

  const owners = new Map<string, Set<string>>();
  const headers = new Map<string, ComposerHeader[]>();

  for (const workspace of workspaces) {
    const ids = selected.get(workspace.globalDbPath);

    if (!ids) continue;

    const rows = (await reader.read(workspace, true)).filter((row) =>
      ids.has(row.composerId),
    );

    headers.set(workspace.workspaceDbPath, rows);

    for (const row of rows) {
      const key = JSON.stringify([workspace.globalDbPath, row.composerId]);
      const set = owners.get(key) || new Set<string>();

      set.add(workspace.workspaceDbPath);
      owners.set(key, set);
    }
  }

  const globals = new Map<string, HeaderSource[]>();

  for (const globalPath of selected.keys()) {
    const profile = workspaces.filter((w) => w.globalDbPath === globalPath);

    if (!profile.length)
      throw new Error('Selected profile is no longer available.');
    const { sources } = await reader.globalMetadata(profile[0]);
    const wanted = selected.get(globalPath)!;

    const subset = sources.map((source) => ({
      ...source,
      records: source.records.filter((h) => wanted.has(h.composerId)),
    }));

    globals.set(globalPath, subset);

    for (const source of subset)
      for (const row of source.records) {
        if (
          !row.workspaceIdentifier ||
          profile.some((w) =>
            matchesWorkspaceStorage(row, w.storageId, w.identity),
          )
        )
          continue;
        const key = JSON.stringify([globalPath, row.composerId]);
        const set = owners.get(key) || new Set<string>();

        set.add('unresolved-global-owner');
        owners.set(key, set);
      }
  }

  return { owners, headers, globals };
}

/** Compare selected global index rows under the write transaction, without hashing message bodies. */
export async function verifyGlobalSelection(
  conn: SqliteConn,
  /** Database layout already inspected. */
  layout: Layout,
  expected: HeaderSource[],
  /** Composer ids selected for this operation. */
  ids: Set<string>,
): Promise<HeaderSource[]> {
  const current = await readGlobalHeaderSources(conn, layout, false, true);

  /** Stable JSON signature of the header rows still selected. */
  const signature = (
    /** Header rows still selected. */
    sources: HeaderSource[],
  ) =>
    JSON.stringify(
      sources.map((source) => ({
        source: source.source,
        records: source.records
          .filter((row) => ids.has(row.composerId))
          .map((row) => JSON.stringify(row))
          .sort(),
      })),
    );

  if (signature(current) !== signature(expected))
    throw new Error(
      'Selected chat indices changed during preparation. Refresh and select the chats again.',
    );

  return current;
}
