import { inspectChatPresence } from './chat-presence';
import type { ComposerHeader, TransferContext, WorkspaceEntry } from './types';
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
  /** Header cache for one scan. A new reader is used when omitted. */
  headers: WorkspaceHeaderReader = new WorkspaceHeaderReader(ctx),
): Promise<{
  /** Classification. `unknown` is not permission to delete. */
  state: WorkspaceHistoryState;
  /** Known composer ids. Empty when the indexes could not be read. */
  ids: string[];
}> {
  try {
    const rows = await headers.read(entry, true);

    const ids = [...new Set(rows.map((row) => row.composerId))];

    if (!ids.length) return { state: 'empty', ids };

    let unreadable = false;

    for (const row of rows) {
      let presence: Awaited<ReturnType<typeof inspectChatPresence>>;

      try {
        presence = await inspectChatPresence(
          { ...ctx, database: entry.globalDbPath },
          row.composerId,
          { emptyShell: true },
        );
      } catch (error) {
        if (ctx.signal?.aborted) throw error;

        // One unsupported id must not hide the other composers in this workspace.
        unreadable = true;
        continue;
      }

      if (presence === 'present') return { state: 'present', ids };

      // A title without a readable body is not proof that the workspace is empty.
      if (
        presence === 'unknown' ||
        (presence === 'missing' && namedHeader(row))
      )
        unreadable = true;
    }

    return { state: unreadable ? 'unknown' : 'empty', ids };
  } catch (error) {
    if (ctx.signal?.aborted) throw error;

    return { state: 'unavailable', ids: [] };
  }
}

/** True when the header stores a title that may describe chat history. */
function namedHeader(row: ComposerHeader): boolean {
  return (
    (typeof row.name === 'string' && row.name.trim() !== '') ||
    (typeof row.subtitle === 'string' && row.subtitle.trim() !== '')
  );
}
