import type { TransferContext, WorkspaceEntry } from './types';

/** Exact identities approved in the deletion confirmation; names are never keys. */
export interface DeleteTarget {
  /** Physical workspace/global storage pair. */
  workspace: WorkspaceEntry;
  /** Duplicate IDs are normalized before any mutation. */
  ids: string[];
  /** Confirmed hash of this target's global chat rows. Checked inside the write transaction. */
  chatFingerprint?: string;
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

/**
 * What the user asked to delete. A workspace request is not "every currently loaded chat".
 * An empty id list is not a workspace request.
 */
export type ManagedDeleteRequest =
  | {
      /** Delete the local workspace storage directory and its exclusive history. */
      kind: 'workspace-data';
      /** Physical workspace/global storage pair. */
      workspace: WorkspaceEntry;
      /**
       * Set only by Select empty workspaces.
       * Rechecked before any write. A later manual check does not keep it.
       */
      requireEmpty?: true;
      /** Parent kept because a subagent was not selected. */
      note?: string;
    }
  | {
      /** Delete these chats and keep the workspace directory. */
      kind: 'chats';
      /** Physical workspace/global storage pair. */
      workspace: WorkspaceEntry;
      /** Composer ids. Not inferred from "all children were checked". */
      ids: string[];
      /** Parent kept because a subagent was not selected. */
      note?: string;
    };

/** One checked target after a read-only preflight. Message bodies are not stored. */
export interface ManagedPlanTarget {
  /** Workspace directory, or chats inside a kept directory. */
  kind: 'workspace-data' | 'chats';
  /** Physical workspace/global storage pair captured for the confirmation. */
  workspace: WorkspaceEntry;
  /** Exclusive composer ids approved for this target. */
  ids: string[];
  /** Database and WAL identity captured with the id list. */
  token: string;
  /** Display name. Not a storage key. */
  name: string;
  /** Location label, such as "This computer". */
  location: string;
  /** Project or storage path shown in the dialog. */
  pathLabel: string;
  /** `dev:ino` of the workspace directory captured with the plan. */
  directoryId?: string;
  /**
   * Hash of the selected global chat rows.
   * A live Cursor rewrite of unrelated global state does not change it.
   */
  chatFingerprint?: string;
  /** Select empty workspaces asked for a workspace that still has no history. */
  requireEmpty?: true;
  /** The open window: its chats may be deleted and its storage directory stays. */
  storageKept?: true;
}

/** Read-only plan. Execution rejects it when the profile or token no longer matches. */
export interface ManagedDeletePlan {
  /** User-data directory the paths were resolved against. */
  userDataRoot: string;
  /** Targets in preview order. */
  targets: ManagedPlanTarget[];
  /**
   * Global database and WAL identity captured with the plan.
   * Keyed by `globalDbPath`. Message bodies are not stored.
   */
  globalTokens?: Record<string, string>;
  /** Parents withheld because a descendant was not selected. */
  keptNote?: string;
}

/** Per-target result. SQL success is not workspace deletion. */
export interface ManagedDeleteOutcome {
  /** Workspace directory, or chats inside a kept directory. */
  kind: 'workspace-data' | 'chats';
  /** `workspaceDbPath`. Names are not identities. */
  workspaceKey: string;
  /** Display name copied from the plan. Not an identity. */
  label: string;
  /** Composer ids whose delete transaction committed. */
  chatIdsDeleted: string[];
  /** Composer ids retained by the chat-only ownership rules. */
  chatIdsSkipped: string[];
  /** Directory step. Chat-only work uses `not-requested`. */
  storage:
    | 'not-requested'
    | 'not-started'
    | 'deleted'
    | 'partial'
    | 'failed'
    | 'unknown';
  /** Stable filesystem or verification code, when one exists. */
  errorCode?: string;
  /** Short reason safe to show. No SQL text and no message bodies. */
  errorMessage?: string;
}

/** Worker result for one confirmed managed deletion. */
export interface ManagedDeleteResult {
  /** One entry per plan target, including targets that did not start. */
  outcomes: ManagedDeleteOutcome[];
  /** Cancellation after zero or more committed targets. */
  cancelled?: boolean;
  /** A commit acknowledgement was lost. No directory deletion follows that target. */
  uncertain?: boolean;
  /** Stop reason. Earlier outcomes remain. */
  error?: string;
}

/** Why a plan cannot be confirmed. Nothing has been deleted. */
export interface ManagedDeleteRefusal {
  /** Modal title. */
  title: string;
  /** Modal detail. */
  detail: string;
}

/** Read-only preflight result. */
export type ManagedPrepareResult =
  | {
      /** Preflight succeeded. */
      ok: true;
      /** Plan the confirmation and the write job share. */
      plan: ManagedDeletePlan;
    }
  | ({
      /** Preflight refused the whole request. */
      ok: false;
    } & ManagedDeleteRefusal);

/** Fields shared by deletion worker jobs. */
type DeletionConnection = Pick<
  TransferContext,
  'executable' | 'initFile' | 'timeoutMs' | 'busyTimeoutMs'
>;

/** What the host knows about the window that started the operation. */
export interface ManagedWindowFacts {
  /** `state.vscdb` of the workspace open in this window, when the host has one. */
  database?: string;
  /** Project identity when the physical database path is not available. */
  identity?: WorkspaceEntry['identity'];
  /** True when this window has no folder and no workspace file. */
  emptyWindow: boolean;
}

/** Ordinary cancellable transfer job; it never waits for the IDE to exit. */
export type DeletionJob = DeletionConnection &
  (
    | {
        /** Worker task discriminator. */
        kind: 'delete-chats';
        /** Complete discovered inventory for affected profiles. */
        workspaces: WorkspaceEntry[];
        /** Confirmed exact chat selection. */
        targets: DeleteTarget[];
      }
    | ({
        /** Read-only plan. Closes its SQLite processes before returning. */
        kind: 'prepare-managed-delete';
        /** User-data directory to resolve. */
        userDataRoot: string;
        /** Typed selection. Workspace scope is not a list of ids. */
        requests: ManagedDeleteRequest[];
        /** Profile inventory used for ownership, not a write list. */
        workspaces: WorkspaceEntry[];
      } & ManagedWindowFacts)
    | ({
        /** Re-check the plan, then delete. */
        kind: 'delete-managed-data';
        /** Plan returned by the matching prepare job. */
        plan: ManagedDeletePlan;
        /** Fresh inventory. A changed profile rejects the plan. */
        workspaces: WorkspaceEntry[];
      } & ManagedWindowFacts)
    | ({
        /** Read-only empty-history scan. It does not change the checked set. */
        kind: 'find-empty-workspaces';
        /** User-data directory the inventory belongs to. */
        userDataRoot: string;
        /** Full Manage Chats inventory, including rows hidden by the eye toggle. */
        workspaces: WorkspaceEntry[];
      } & ManagedWindowFacts)
  );

/** Read-only result of Select empty workspaces. */
export interface EmptyWorkspaceScan {
  /** Workspaces that may be checked. The current window is omitted. */
  selected: WorkspaceEntry[];
  /** Rows that could not be proved empty or nonempty. */
  unchecked: number;
  /** Empty history, including the current window, which is not selected. */
  candidates: number;
}
