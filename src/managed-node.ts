import type { ComposerHeader, WorkspaceEntry } from './types';

/** One workspace row, one chat under it, or a read failure. */
export interface ManagedNode {
  /** Workspace this row belongs to. */
  workspace: WorkspaceEntry;
  /** Chat under a workspace. Absent on workspace and error rows. */
  chat?: ComposerHeader;
  /** Read failure shown instead of that workspace's chats. */
  error?: string;
}
