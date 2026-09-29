import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as db from './db';
import { defaultPlansDirectory } from './plans';
import { backupDatabase } from './sqlite';
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
  reason: ExportChatIssue['reason'],
  extra?: Pick<
    ExportChatIssue,
    'missingBlobs' | 'missingImages' | 'missingPlans'
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
export function plansDirOf(ctx: TransferContext): string {
  return ctx.plansDir || defaultPlansDirectory();
}

/** Bind a TransferContext to one database file. */
export function connOf(
  ctx: TransferContext,
  dbPath: string,
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
  ctx: TransferContext,
  workspace: WorkspaceEntry,
): Promise<{
  connWs: SqliteConn;
  connGl: SqliteConn;
  wsInfo: Awaited<ReturnType<typeof db.inspectDatabase>>;
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

/** Read composer bodies and bubbles from a WAL-safe snapshot of the global DB. */
export async function withGlobalSnapshot<T>(
  ctx: TransferContext,
  workspace: WorkspaceEntry,
  fn: (conn: SqliteConn) => Promise<T>,
): Promise<T> {
  const dir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'cct-export-snap-'),
  );
  const dest = path.join(dir, 'global-snapshot.vscdb');
  try {
    await backupDatabase({
      executable: ctx.executable,
      database: workspace.globalDbPath,
      dest,
      initFile: ctx.initFile,
      signal: ctx.signal,
      timeoutMs: ctx.timeoutMs,
      busyTimeoutMs: ctx.busyTimeoutMs,
    });
    return await fn(connOf(ctx, dest, true));
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}
