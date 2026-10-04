import * as db from './db';
import { canvasesDirectoryForWorkspace } from './canvases';
import { defaultPlansDirectory } from './plans';
import type {
  ComposerHeader,
  ExportChatIssue,
  SqliteConn,
  TransferContext,
  WorkspaceEntry,
} from './types';

/** Operation-log identity: real title when present, always the composer id. */
export function chatLogLabel(header: ComposerHeader): string {
  const raw = typeof header.name === 'string' ? header.name.trim() : '';
  const name = raw ? JSON.stringify(raw.slice(0, 120)) : '(untitled)';

  return `id=${header.composerId} name=${name}`;
}

/** Export issue row with composer id, optional name, and a typed reason. */
export function chatIssue(
  header: ComposerHeader,
  /** Why the item was skipped or refused. */
  reason: ExportChatIssue['reason'],
  extra?: Pick<
    ExportChatIssue,
    | 'missingBlobs'
    | 'missingImages'
    | 'missingPlans'
    | 'missingCanvases'
    | 'missingMessages'
  >,
): ExportChatIssue {
  const issue: ExportChatIssue = {
    composerId: header.composerId,
    reason,
    ...extra,
  };

  if (typeof header.name === 'string' && header.name.trim()) {
    issue.name = header.name;
  }

  return issue;
}

/** Plans directory for this transfer, or `~/.cursor/plans`. */
export function plansDirOf(
  /** Transfer hooks, timeouts, and cancellation. */
  ctx: TransferContext,
): string {
  return ctx.plansDir || defaultPlansDirectory();
}

/**
 * Canvas directory for this transfer.
 * An explicit context path wins; otherwise the workspace project slug is used.
 */
export function canvasesDirOf(
  /** Transfer hooks, timeouts, and cancellation. */
  ctx: TransferContext,
  workspace: WorkspaceEntry,
): string | null {
  if (ctx.canvasesDir) return ctx.canvasesDir;

  return canvasesDirectoryForWorkspace(workspace);
}

/** Bind a TransferContext to one database file. */
export function connOf(
  /** Transfer hooks, timeouts, and cancellation. */
  ctx: TransferContext,
  dbPath: string,
  /** Open the database without writing. */
  readOnly: boolean,
): SqliteConn {
  return {
    executable: ctx.executable,
    database: dbPath,
    initFile: ctx.initFile,
    readOnly,
    signal: ctx.signal,
    timeoutMs: ctx.timeoutMs,
    busyTimeoutMs: ctx.busyTimeoutMs,
  };
}

/** Inspect workspace and global DBs for the same storage pair. */
export async function inspectPair(
  /** Transfer hooks, timeouts, and cancellation. */
  ctx: TransferContext,
  workspace: WorkspaceEntry,
): Promise<{
  /** Read-only connection to the workspace database. */
  connWs: SqliteConn;
  /** Read-only connection to the global database. */
  connGl: SqliteConn;
  /** Workspace schema and layout. */
  wsInfo: Awaited<ReturnType<typeof db.inspectDatabase>>;
  /** Global schema and layout. */
  glInfo: Awaited<ReturnType<typeof db.inspectDatabase>>;
}> {
  const connWs = connOf(ctx, workspace.workspaceDbPath, true);
  const connGl = connOf(ctx, workspace.globalDbPath, true);
  const wsInfo = await db.inspectDatabase(connWs);
  const glInfo = await db.inspectDatabase(connGl);

  return { connWs, connGl, wsInfo, glInfo };
}

/** Let the host handle Cancel between large JSON remaps. */
export async function yieldToHost(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();

  await new Promise<void>((resolve) => setImmediate(resolve));
}
