import { inspectChatPresence } from './chat-presence';
import type { TransferContext, WorkspaceEntry } from './types';
import { WorkspaceHeaderReader } from './workspace-header-reader';

/**
 * Whether supported indexes show chat history.
 * `unknown` includes incomplete or unsupported records. Absence of a result is not `empty`.
 */
export type WorkspaceHistoryState =
  'empty' | 'present' | 'unknown' | 'unavailable';

/**
 * Read supported indexes until the first history row.
 * Selection-only references are included. Message bodies and blob graphs are not loaded.
 * A missing `composerData` row for a known id is `unknown`, not `empty`.
 */
export async function assessWorkspaceHistory(
  /** Transfer hooks, timeouts, and cancellation. */
  ctx: TransferContext,
  /** Workspace whose global and local indexes are read. */
  entry: WorkspaceEntry,
): Promise<{
  /** Classification. `unknown` is not permission to delete. */
  state: WorkspaceHistoryState;
  /** Known composer ids. Empty when the indexes could not be read. */
  ids: string[];
}> {
  try {
    const reader = new WorkspaceHeaderReader(ctx);

    const ids = [
      ...new Set((await reader.read(entry, true)).map((row) => row.composerId)),
    ];

    if (!ids.length) return { state: 'empty', ids };

    for (const id of ids) {
      const presence = await inspectChatPresence(
        { ...ctx, database: entry.globalDbPath },
        id,
        { emptyShell: true },
      );

      if (presence === 'present') return { state: 'present', ids };
      if (presence !== 'empty') return { state: 'unknown', ids };
    }

    return { state: 'empty', ids };
  } catch (error) {
    if (ctx.signal?.aborted) throw error;

    return { state: 'unavailable', ids: [] };
  }
}
