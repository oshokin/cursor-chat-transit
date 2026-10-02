/** JSON value used when cloning payloads for pointer rewrites. */
export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };

/** URI components used for workspace identity (not fsPath). */
export interface UriParts {
  /** Scheme such as `file` or `vscode-remote`. */
  scheme: string;
  /** Host or SSH authority; empty for a local file URI. */
  authority: string;
  /** Decoded URI path; never treated as a filesystem identity on its own. */
  path: string;
  /** Optional query string, stored as Cursor wrote it. */
  query?: string;
  /** Optional fragment, stored as Cursor wrote it. */
  fragment?: string;
}

/** Folder window versus a multi-root `.code-workspace` file. */
export type WorkspaceKind = 'folder' | 'workspace';

/** How this extension identifies a workspace: kind plus URI components, never fsPath alone. */
export interface WorkspaceIdentity {
  /** Folder window or multi-root workspace file. */
  kind: WorkspaceKind;
  /** Canonical URI parts for this workspace. */
  uri: UriParts;
}

/** Cursor's stored workspace pointer on a composer header; fields may be missing or extra. */
export interface WorkspaceIdentifier {
  /** Optional Cursor workspace id when the header recorded one. */
  id?: string;
  /** URI Cursor stored; extra VS Code serialisation fields may appear. */
  uri?: UriParts & {
    /** VS Code marshalled-id tag; ignored for identity. */
    $mid?: number;
    /** Host filesystem path when Cursor included one. */
    fsPath?: string;
    /** External URI string when Cursor included one. */
    external?: string;
  };
}

/** Composer metadata as stored in headers and list blobs. Unknown keys are preserved. */
export interface ComposerHeader {
  /** Cursor composer id; the stable key for this chat. */
  composerId: string;
  /** Display title when Cursor stored one. */
  name?: string;
  /** Secondary title line when present. */
  subtitle?: string;
  /** Creation time as Cursor stored it. */
  createdAt?: number;
  /** Last activity time as Cursor stored it. */
  lastUpdatedAt?: number;
  /** Whether Cursor marked the chat archived. */
  isArchived?: boolean;
  /** Whether this header is a Best-of-N subcomposer. */
  isBestOfNSubcomposer?: boolean;
  /** Checkpoint timestamp when Cursor stored one. */
  conversationCheckpointLastUpdatedAt?: number;
  /** Workspace this chat was bound to, if recorded. */
  workspaceIdentifier?: WorkspaceIdentifier;
  /** Unknown header keys pass through unchanged. */
  [key: string]: unknown;
}

/** One conversation bubble: KV key, JSON text, and the bubble id parsed from the key. */
export interface BubbleRecord {
  /** SQLite key, typically `bubbleId:<composer>:<bubble>`. */
  key: string;
  /** JSON text of the bubble body. */
  value: string;
  /** Bubble id parsed from the key. */
  bubbleId: string;
}

/** One Cursor workspaceStorage folder paired with the global database. */
export interface WorkspaceEntry {
  /** Absolute `workspaceStorage` folder for this workspace. */
  storageRoot: string;
  /** Folder name Cursor assigned under `workspaceStorage`. */
  storageId: string;
  /** Absolute path of this workspace's `state.vscdb`. */
  workspaceDbPath: string;
  /** Absolute path of the paired global `state.vscdb`. */
  globalDbPath: string;
  /** Recency used for picker order (database or WAL mtime). */
  mtime: number;
  /** Parsed workspace identity when `workspace.json` is usable. */
  identity?: WorkspaceIdentity;
  /** Stable picker/import key for this entry. */
  key: string;
}

/** sqlite3 CLI invocation bound to one database file. */
export interface SqliteConn {
  /** Absolute path of the sqlite3 executable. */
  executable: string;
  /** Owned persistent read session; never serialized to a worker. */
  session?: import('./sqlite-session').SqliteSession;
  /** Database file this connection will open. */
  database: string;
  /** sqlite3 `-init` file that sets timeouts and modes. */
  initFile: string;
  /** When true, open the database read-only. */
  readOnly?: boolean;
  /** Cancellation for the child process. */
  signal?: AbortSignal;
  /** Wall-clock limit for this sqlite3 invocation. */
  timeoutMs?: number;
  /** SQLite busy timeout applied through the init file. */
  busyTimeoutMs?: number;
}

/** Named stage reported to the sidebar and operation log. */
export type TransferPhase =
  | 'extract'
  | 'pack'
  | 'selection'
  | 'read'
  | 'validate'
  | 'collect'
  | 'prepare'
  | 'write'
  | 'verify'
  | 'global-commit'
  | 'workspace-commit';

/** Optional counts for a phase; used only for progress, not for correctness. */
export interface TransferPhaseMetrics {
  /** Current chat, file and measurable unit. */
  chatName?: string;
  /** Path or name of the file currently being measured. */
  file?: string;
  /** What `processed` and `total` count, such as messages or blobs. */
  unit?: string;
  /** Stable measurable operation; changing display paths must not reset its rate. */
  scope?: string;
  /** 1-based position of the current chat in this phase. */
  chatIndex?: number;
  /** Number of chats in this phase. */
  chatTotal?: number;
  /** Chats touched in this phase. */
  chats?: number;
  /** Bubbles touched in this phase. */
  bubbles?: number;
  /** Bytes touched in this phase. */
  bytes?: number;
  /** Items finished so far. */
  processed?: number;
  /** Items expected in this phase. */
  total?: number;
  /** Resources touched in this phase. */
  resources?: number;
  /** Missing dependencies counted in this phase. */
  missing?: number;
}

/** Shared sqlite3, timeout, cancellation, and UI hooks for one transfer. */
export interface TransferContext {
  /** Absolute path of the sqlite3 executable. */
  executable: string;
  /** sqlite3 `-init` file that sets timeouts and modes. */
  initFile: string;
  /** Cancellation for the whole transfer. */
  signal?: AbortSignal;
  /** Wall-clock limit for each sqlite3 invocation. */
  timeoutMs?: number;
  /** SQLite busy timeout applied through the init file. */
  busyTimeoutMs?: number;
  /** Progress callback for named phases. */
  onPhase?: (phase: TransferPhase, metrics?: TransferPhaseMetrics) => void;
  /** Bounded chat-level facts for the operation log (id + name, not SQL). */
  onNote?: (message: string) => void;
  /** Local plans directory; default `~/.cursor/plans`. */
  plansDir?: string;
  /**
   * Canvas directory for this transfer.
   * Unset uses `~/.cursor/projects/{slug}/canvases` for the workspace.
   */
  canvasesDir?: string;
}

/** Table names and PRAGMA table_info snapshots for layout detection. */
export interface SchemaInfo {
  /** Table names present in this database. */
  tables: Set<string>;
  /** Column types keyed as `table.column`. */
  types: Record<string, string>;
  /** Raw `PRAGMA table_info` rows keyed by table name. */
  info: Record<string, string[][]>;
}

/** Which known tables exist and whether this adapter will write them. */
export interface Layout {
  /** Whether `ItemTable` exists. */
  itemTable: boolean;
  /** Whether `cursorDiskKV` exists. */
  cursorDiskKV: boolean;
  /** Whether `composerHeaders` exists as a writable table. */
  composerHeaders: boolean;
  /** Column names on `composerHeaders` when the table exists. */
  headerColumns: string[];
  /** Whether global-database writes are allowed. */
  canWriteGlobal: boolean;
  /** Whether workspace-database writes are allowed. */
  canWriteWorkspace: boolean;
  /** True when an unsupported constraint forbids writes. */
  writeBlocked: boolean;
  /** Human-readable reason when writes are blocked. */
  unsupportedReason: string | null;
}

/** SQLite value as portable bytes. sha256 is of decoded bytes, not the key. */
export interface SqliteBytes {
  /** How SQLite stored the value. */
  storageClass: 'text' | 'blob';
  /** Canonical base64 of the decoded bytes. */
  base64: string;
  /** Decoded byte length. */
  byteLength: number;
  /** SHA-256 of the decoded bytes. */
  sha256: string;
}

/** Allowlisted cursorDiskKV dependency copied from the source snapshot. */
export interface KvResource {
  /** `cursorDiskKV` key. */
  key: string;
  /** Portable bytes for that key. */
  value: SqliteBytes;
}

/** Image bytes keyed by the bubble `images[].uuid`. Paths stay out of the envelope. */
export interface AttachmentResource {
  /** Attachment UUID from the bubble payload. */
  id: string;
  /** Canonical base64 of the image bytes. */
  base64: string;
  /** Decoded byte length. */
  byteLength: number;
  /** SHA-256 of the decoded bytes. */
  sha256: string;
  /** File extension Cursor used beside the workspace database. */
  extension: string;
  /**
   * Basename to write on import, such as `{uuid}-{variant}.png`.
   * Absent on older exports; those still write `{uuid}.{ext}`.
   */
  filename?: string;
  /**
   * Other basenames with these same bytes.
   * Import rewrites structured paths that use them onto `filename`.
   */
  aliases?: string[];
}

/** Cursor plan markdown keyed by basename. No filesystem path in the envelope. */
export interface PlanResource {
  /** Allowlisted plan basename. */
  filename: string;
  /** Canonical base64 of the markdown bytes. */
  base64: string;
  /** Decoded byte length. */
  byteLength: number;
  /** SHA-256 of the decoded bytes. */
  sha256: string;
}

/** Cursor canvas source keyed by basename. No filesystem path in the envelope. */
export interface CanvasResource {
  /** Allowlisted canvas basename. */
  filename: string;
  /** Canonical base64 of the canvas source. */
  base64: string;
  /** Decoded byte length. */
  byteLength: number;
  /** SHA-256 of the decoded bytes. */
  sha256: string;
}

/** Completeness of blobs, images, plans, and canvases for the chats being transferred. */
export interface DependencyAssessment {
  /** Whether every required dependency was found. */
  status: 'complete' | 'incomplete' | 'unsupported';
  /** Missing `cursorDiskKV` keys. */
  missingKeys: string[];
  /** Missing image UUIDs. */
  missingAttachments: string[];
  /** Missing plan basenames. */
  missingPlans: string[];
  /** Missing canvas basenames. */
  missingCanvases: string[];
}

/** Portable kv, image, plan, and canvas bytes attached to an export envelope. */
export interface ExportResources {
  /** Allowlisted kv rows. */
  kv: KvResource[];
  /** Image attachments. */
  attachments: AttachmentResource[];
  /** Plan files. */
  plans: PlanResource[];
  /** Canvas files. Omitted by older exports. */
  canvases?: CanvasResource[];
}

/** Why one chat was exported incomplete; counts are facts, not guesses. */
export interface ExportChatIssue {
  /** Composer that could not be exported as complete. */
  composerId: string;
  /** Display name when known. */
  name?: string;
  /** Classifier for the incomplete export. */
  reason:
    | 'missing-body'
    | 'missing-dependencies'
    | 'unsupported-state'
    | 'invalid-attachment-id';
  /** Missing blob count when that is the reason. */
  missingBlobs?: number;
  /** Missing image count when that is the reason. */
  missingImages?: number;
  /** Missing plan count when that is the reason. */
  missingPlans?: number;
  /** Missing canvas count when that is the reason. */
  missingCanvases?: number;
}

/** Partial workspace pointer some older exports stored instead of a full identity. */
export interface ExportSourceWorkspaceHint {
  /** Folder versus multi-root workspace, as the exporter wrote it. */
  kind: string;
  /** URI as stored; only `path` is required for display. */
  uri: {
    /** Decoded URI path; not a filesystem identity. */
    path: string;
  };
}

/** Legacy backup paths retained only when reading an existing import journal. */
export interface DatabaseBackupPair {
  /** Backup of the global `state.vscdb`. */
  global: string;
  /** Backup of the workspace `state.vscdb`. */
  workspace: string;
}

/** Named skip: which composer was refused, and why. */
export interface SkippedChatRef {
  /** Source composer id. */
  composerId: string;
  /** Display name when the bundle recorded one. */
  name?: string;
  /** Human-readable skip reason. */
  reason: string;
}

/** Internal compatibility DTO for transfer helpers and tests; archives use ZIP v4. */
export interface ExportObject {
  /** Internal DTO version; not the on-disk ZIP format version. */
  formatVersion?: number;
  /** Provenance of the export, never a required write contract. */
  source?: {
    /** Schema label when the exporter recorded one. */
    schema?: string;
    /** Workspace the chats were read from. */
    workspace?: WorkspaceIdentity | ExportSourceWorkspaceHint;
  };
  /** Selected composer headers. */
  allComposers: ComposerHeader[];
  /** Composer bodies keyed by composer id. */
  composers: Record<string, string>;
  /** Bubble groups keyed by composer id. */
  bubbles?: Record<string, BubbleRecord[]>;
  /** Portable resources for format 3. */
  resources?: ExportResources;
  /** Export totals and incomplete ids. */
  summary?: {
    /** True only when every selected chat exported complete. */
    complete: boolean;
    /** Composer ids that were incomplete. */
    incomplete: string[];
    /** How many chats the user selected. */
    selected: number;
    /** How many chats were written. */
    exported: number;
    /** Dependency assessment for the selection. */
    dependencies?: DependencyAssessment;
    /** Per-chat incomplete reasons. */
    issues?: ExportChatIssue[];
  };
}

/** One imported or skipped chat named for the operation log. */
export interface ImportChatRef {
  /** Source composer id from the export. */
  composerId: string;
  /** Display name when known. */
  name?: string;
  /** Destination composer id when a copy exists. */
  targetComposerId?: string;
  /** Why this chat was skipped or copied. */
  reason?: string;
}

/** Import outcome counts and the chats that need a calm, named notice. */
export interface ImportResult {
  /** Chats written in this run. */
  imported: number;
  /** Complete copies. */
  complete: number;
  /** History-only copies. */
  historyOnly: number;
  /** Chats refused or skipped. */
  skipped: number;
  /** Identical snapshots that were not written again. */
  alreadyImported: number;
  /** Legacy already-present count kept for older callers. */
  alreadyPresent: number;
  /** Changed snapshots added as extra copies. */
  newVersions: number;
  /** Incomplete outcomes in this run. */
  incomplete: number;
  /** Destination composer ids created in this run. */
  composerIds: string[];
  /** Destination ids imported as history-only. */
  historyOnlyIds: string[];
  /** Named skips. */
  skippedChats: SkippedChatRef[];
  /** Named identical snapshots. */
  alreadyImportedChats: ImportChatRef[];
  /** Named extra copies. */
  newVersionChats: ImportChatRef[];
  /** Verified earlier copies that lost their workspace bindings and were written again. */
  restored?: number;
  /** Named restored copies. */
  restoredChats?: ImportChatRef[];
}

/** Transfer failure with optional incomplete ids. */
export class TransferError extends Error {
  /** Machine-readable code such as `LOCKED`, `LOCK_RECOVERY_REQUIRED`, or `PARTIAL`. */
  code?: string;
  /** Composer ids that could not be completed. */
  missing?: string[];
  /** Bounded diagnostic facts for the operation log; never payloads or SQL. */
  detail?: string;
}

/** sqlite3 CLI failure with exit code and truncated stderr. */
export class SqliteError extends Error {
  /** Child exit code or errno. */
  code?: string | number;
  /** Bounded stderr from sqlite3. */
  stderr?: string;
}
