import type { TransferContext, WorkspaceEntry } from './types';

/** Exact identities approved in the deletion confirmation; names are never keys. */
export interface DeleteTarget {
  /** Physical workspace/global storage pair. */
  workspace: WorkspaceEntry;
  /** Duplicate IDs are normalized before any mutation. */
  ids: string[];
}

/** Known committed outcomes; cancellation never hides already completed workspaces. */
export interface DeleteResult {
  /** Deleted composer IDs with the physical database path. */
  deleted: string[];
  /** Shared, absent, or unverified records that were retained. */
  skipped: string[];
  /** An error stops later workspaces; previous commits remain visible here. */
  error?: string;
  /** The active transaction was rolled back; earlier commits remain. */
  cancelled?: boolean;
  /** COMMIT was sent but its acknowledgement was lost; refresh after restarting Cursor. */
  uncertain?: boolean;
}

/** Ordinary cancellable transfer job; it never waits for the IDE to exit. */
export type DeletionJob = Pick<
  TransferContext,
  'executable' | 'initFile' | 'timeoutMs' | 'busyTimeoutMs'
> & {
  /** Worker task discriminator. */
  kind: 'delete-chats';
  /** Complete discovered inventory for affected profiles. */
  workspaces: WorkspaceEntry[];
  /** Confirmed exact chat selection. */
  targets: DeleteTarget[];
};
