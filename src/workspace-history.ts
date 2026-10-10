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
 * A missing `composerData` row with no bubbles is no history. An unreadable body is `unknown`.
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

    let unreadable = false;

    for (const id of ids) {
      let presence: Awaited<ReturnType<typeof inspectChatPresence>>;

      try {
        presence = await inspectChatPresence(
          { ...ctx, database: entry.globalDbPath },
          id,
          { emptyShell: true },
        );
      } catch (error) {
        if (ctx.signal?.aborted) throw error;

        // One unsupported id must not hide the other composers in this workspace.
        unreadable = true;
        continue;
      }

      if (presence === 'present') return { state: 'present', ids };
      if (presence === 'unknown') unreadable = true;
    }

    return { state: unreadable ? 'unknown' : 'empty', ids };
  } catch (error) {
    if (ctx.signal?.aborted) throw error;

    return { state: 'unavailable', ids: [] };
  }
}
