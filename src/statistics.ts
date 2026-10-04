import { MAX_SQLITE_VALUE_BYTES } from './bundle-limits';
import { healthLabel, inspectChatHealth } from './chat-health';
import { inspectChatPresence } from './chat-presence';
import { sqlText } from './core';
import { readKvText } from './db';
import { hasChatTitle } from './picker';
import { openReadTransaction } from './read-transaction';
import { execSql } from './sqlite';
import { connOf } from './transfer-context';
import { traceIO, transferEvent } from './transfer-events';
import type { ComposerHeader, TransferContext, WorkspaceEntry } from './types';
import { WorkspaceHeaderReader } from './workspace-header-reader';

/** Only metadata crosses IPC; bodies stay in the worker. */
export type StatisticsJob = Pick<
  TransferContext,
  'executable' | 'initFile' | 'timeoutMs' | 'busyTimeoutMs'
> & {
  /** Source assessment: presence for workspace filtering, full health for chat selection. */
  deepCheck?: boolean;
  /** Custom resource locations captured for this scan. */
  plansDir?: string;
  /** Allowlisted canvases directory. */
  canvasesDir?: string;
} & (
    | {
        /** Worker task discriminator. */
        kind: 'workspace-statistics';
        /** Workspaces whose headers are counted. */
        workspaces: WorkspaceEntry[];
      }
    | {
        kind: 'chat-statistics';
        workspace: WorkspaceEntry;
        /** Omit for all current workspace headers; an empty list means no selection. */
        chats?: Pick<ComposerHeader, 'composerId' | 'name'>[];
      }
  );

/** Incremental result for one picker row. */
export interface StatisticsUpdate {
  /** Storage pair key or composer id. */
  key: string;
  /** Short, user-facing statistic. */
  detail: string;
  /** Read failed rather than a measured zero. */
  failed?: boolean;
  /** Result of the requested deep check; unknown is not corruption. */
  health?: import('./chat-health').ChatHealth;
  /** Confirmed complete, nonempty source data. */
  eligible?: boolean;
  /** Confirmed absence of readable chat history; view filtering only. */
  hide?: boolean;
}

/** A storage id alone need not be unique across profiles. */
export function workspaceStatisticsKey(entry: WorkspaceEntry): string {
  return JSON.stringify([entry.storageRoot, entry.storageId]);
}

/** Count names with the same rules as the chat picker. Untitled chats are real chats too. */
export function workspaceCounts(headers: ComposerHeader[]): string {
  const titled = headers.filter((h) => hasChatTitle(h.name)).length;

  return `${titled.toLocaleString('en-US')} titled · ${(headers.length - titled).toLocaleString('en-US')} untitled`;
}

/** Count recognized conversation entries, without treating unknown metadata as zero. */
export function userMessageCount(
  body: Record<string, unknown>,
): number | undefined {
  if (
    body.fullConversationHeadersOnly !== undefined &&
    !Array.isArray(body.fullConversationHeadersOnly)
  )
    return undefined;

  const entries = Array.isArray(body.fullConversationHeadersOnly)
    ? body.fullConversationHeadersOnly
    : Array.isArray(body.conversation)
      ? body.conversation
      : undefined;

  if (!entries) return undefined;
  let count = 0;
  const seen = new Map<string, boolean>();

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') return undefined;
    const type = entry.type;
    const role = entry.role;
    const user = type === 1 || (type === undefined && role === 'user');

    if (
      !user &&
      type !== 2 &&
      !(type === undefined && ['assistant', 'system', 'tool'].includes(role))
    )
      return undefined;
    const id = typeof entry.bubbleId === 'string' ? entry.bubbleId : undefined;

    if (id && seen.has(id)) {
      if (seen.get(id) !== user) return undefined;
      continue;
    }

    if (id) seen.set(id, user);
    if (user) count++;
  }

  return count;
}

/** Storage format is observable; continuation support is controlled by Cursor. */
export function chatStatistics(body: Record<string, unknown>): string {
  const count = userMessageCount(body);

  const messages =
    count === undefined
      ? 'Message count unavailable'
      : `${count.toLocaleString('en-US')} user message${count === 1 ? '' : 's'}`;

  const format =
    body.isNAL === false
      ? 'Legacy format — may not continue'
      : body.isNAL === true
        ? 'Agent format'
        : 'Format unknown';

  return `${messages} · ${format}`;
}

/** Scan sequentially, release read views between rows, and keep row failures local. */
export async function runStatistics(
  job: StatisticsJob,
  signal: AbortSignal,
  /** Refresh the UI as results arrive. */
  update: (row: StatisticsUpdate) => void,
): Promise<{
  /** How many workspace scans failed. */
  failed: number;
}> {
  const ctx = { ...job, signal };

  const reader = new WorkspaceHeaderReader(ctx);

  const rows =
    job.kind === 'workspace-statistics'
      ? job.workspaces
      : (job.chats ?? (await reader.read(job.workspace)));

  let failed = 0;

  for (const row of rows) {
    signal.throwIfAborted();

    const workspace =
      'storageId' in row
        ? row
        : (
            job as Extract<
              StatisticsJob,
              {
                /** Worker task discriminator. */
                kind: 'chat-statistics';
              }
            >
          ).workspace;

    const key =
      'storageId' in row ? workspaceStatisticsKey(row) : row.composerId;

    const fields =
      'storageId' in row
        ? { path: workspace.workspaceDbPath, key, source: workspace.key }
        : {
            path: workspace.globalDbPath,
            chatId: row.composerId,
            chatName: row.name,
          };

    try {
      let eligible: boolean | undefined;
      let chatHealth: import('./chat-health').ChatHealth | undefined;
      let hide: boolean | undefined;

      const detail = await traceIO(
        'storageId' in row ? 'Count workspace chats' : 'Analyze chat metadata',
        fields,
        async () => {
          if ('storageId' in row) {
            const headers = await reader.read(workspace);

            if (job.deepCheck) {
              hide = true;

              for (let start = 0; hide && start < headers.length; start += 32) {
                signal.throwIfAborted();

                const view = await openReadTransaction(
                  connOf(ctx, workspace.globalDbPath, true),
                );

                try {
                  for (const header of headers.slice(start, start + 32)) {
                    signal.throwIfAborted();

                    try {
                      const status = await traceIO(
                        'Check chat history presence',
                        {
                          path: workspace.globalDbPath,
                          chatId: header.composerId,
                          chatName: header.name,
                        },
                        () => inspectChatPresence(view.conn, header.composerId),
                      );

                      hide = status === 'empty' || status === 'missing';

                      transferEvent({
                        action: {
                          present: 'Stored chat history found; keep workspace',
                          empty: 'No messages',
                          missing: 'No stored chat data',
                          unknown: 'Chat presence uncertain; keep workspace',
                        }[status],
                        status: 'info',
                        path: workspace.globalDbPath,
                        chatId: header.composerId,
                        chatName: header.name,
                      });

                      if (!hide) break;
                    } catch (error) {
                      signal.throwIfAborted();
                      failed++;
                      hide = false;

                      transferEvent({
                        action: 'Chat presence check failed',
                        status: 'failed',
                        path: workspace.globalDbPath,
                        chatId: header.composerId,
                        chatName: header.name,
                        errorCode:
                          error instanceof Error && 'code' in error
                            ? String(error.code)
                            : 'CHECK_FAILED',
                      });

                      break;
                    }
                  }
                } finally {
                  await view.close();
                }
              }

              transferEvent({
                action: hide
                  ? 'Workspace has no readable chat history'
                  : 'Keep workspace with readable or uncertain history',
                status: 'info',
                path: workspace.workspaceDbPath,
                key,
              });
            }

            return workspaceCounts(headers);
          }

          const view = await openReadTransaction(
            connOf(ctx, workspace.globalDbPath, true),
          );

          try {
            // A length probe in the same read view prevents huge values from entering Node.
            const size = await execSql({
              ...view.conn,
              sql: `SELECT length(CAST(value AS BLOB)) FROM cursorDiskKV WHERE key=${sqlText(`composerData:${row.composerId}`)};`,
            });

            if (!size.trim())
              throw Object.assign(new Error('Chat metadata is missing.'), {
                code: 'CHAT_METADATA_MISSING',
              });
            if (Number(size.trim()) > MAX_SQLITE_VALUE_BYTES)
              throw Object.assign(
                new Error('Chat metadata exceeds the supported record size.'),
                { code: 'CHAT_METADATA_TOO_LARGE' },
              );

            const raw = await readKvText(
              view.conn,
              `composerData:${row.composerId}`,
            );

            const body: unknown = JSON.parse(raw || 'null');

            if (!body || typeof body !== 'object' || Array.isArray(body))
              throw Object.assign(new Error('Chat metadata is invalid.'), {
                code: 'CHAT_METADATA_INVALID',
              });

            const detail = chatStatistics(body as Record<string, unknown>);

            if (!job.deepCheck) return detail;

            const health = await inspectChatHealth(
              ctx,
              workspace,
              view.conn,
              row,
            );

            chatHealth = health;
            eligible = health === 'ready';

            return `${detail} · ${healthLabel[health]}`;
          } finally {
            await view.close();
          }
        },
      );

      signal.throwIfAborted();
      update({ key, detail, eligible, hide, health: chatHealth });

      transferEvent({
        action: `Statistics: ${detail}`,
        status: 'info',
        ...fields,
      });
    } catch (error) {
      signal.throwIfAborted();
      failed++;

      update({
        key,
        detail: 'Statistics unavailable — see operation log',
        failed: true,
      });

      transferEvent({
        action: 'Statistics unavailable',
        status: 'failed',
        ...fields,
        errorCode:
          error instanceof Error && 'code' in error
            ? String(error.code)
            : error instanceof SyntaxError
              ? 'INVALID_JSON'
              : 'READ_FAILED',
      });
    }
  }

  return { failed };
}
