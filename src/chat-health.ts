import { readChatForExport } from './export-bundle';
import { assertOrderedReferences } from './chat-json';
import { execSql } from './sqlite';
import { bubbleRange, sqlText } from './core';
import { inChat } from './transfer-events';
import type {
  ComposerHeader,
  ExportChatIssue,
  SqliteConn,
  TransferContext,
  WorkspaceEntry,
} from './types';

/** A source-data check, never a promise of Cursor/server compatibility. */
export type ChatHealth =
  'ready' | 'empty' | 'missing' | 'incomplete' | 'unknown';

/** Only confirmed absence of readable history may hide a workspace. */
export function canHideWorkspace(health: ChatHealth[]): boolean {
  return health.every((value) => value === 'empty' || value === 'missing');
}

/** Stable human labels; unknown and incomplete remain visible for manual recovery. */
export const healthLabel: Record<ChatHealth, string> = {
  ready: 'Transfer checks passed',
  empty: 'No messages',
  missing: 'No stored chat data',
  incomplete: 'Incomplete chat data',
  unknown: 'Transfer status unknown',
};

/** Reuse export's streaming reader and resource checks with an in-memory metadata sink. */
export async function inspectChatHealth(
  ctx: TransferContext,
  workspace: WorkspaceEntry,
  conn: SqliteConn,
  header: ComposerHeader,
): Promise<ChatHealth> {
  const id = header.composerId;
  const issues: ExportChatIssue[] = [];
  const available = new Set<string>();
  const messageTypes = new Map<string, unknown>();
  const references: unknown[] = [];
  let fields: Record<string, unknown> = {};
  let layout = 'absent';
  let resources = 0;

  const wrote = await inChat(id, header.name || id, () =>
    readChatForExport({
      ctx,
      workspace,
      conn,
      header,
      issues,
      incomplete: [],
      onBubble: () => undefined,
      writer: {
        async beginChat() {},
        async writeComposer(value, conversation) {
          ctx.signal?.throwIfAborted();
          fields = value;
          layout = conversation;
          if (value.composerId !== undefined && value.composerId !== id)
            throw new Error('Composer identity mismatch.');
        },
        async writeConversation(value) {
          ctx.signal?.throwIfAborted();
          references.push(value);
        },
        async writeBubble(bubbleId, payload) {
          ctx.signal?.throwIfAborted();
          if (!payload || typeof payload !== 'object' || Array.isArray(payload))
            throw new Error('Invalid message payload.');
          const bubble = payload as Record<string, unknown>;

          if (
            available.has(bubbleId) ||
            (bubble.bubbleId !== undefined && bubble.bubbleId !== bubbleId) ||
            (bubble.composerId !== undefined && bubble.composerId !== id)
          )
            throw new Error('Message identity mismatch.');
          available.add(bubbleId);
          messageTypes.set(bubbleId, bubble.type);
        },
        async writeResource() {
          ctx.signal?.throwIfAborted();
          resources++;
        },
        async addBlob() {
          throw new Error('Inspection must not write files.');
        },
        async endChat() {},
      },
    }),
  );

  if (!wrote) {
    // Orphan messages can still be valuable even if the composer row was lost.
    const range = bubbleRange(id);

    const any = await execSql({
      ...conn,
      sql: `SELECT 1 FROM cursorDiskKV WHERE key >= ${sqlText(range.lower)} AND key < ${sqlText(range.upper)} LIMIT 1;`,
    });

    return any.trim() ? 'incomplete' : 'missing';
  }

  if (issues.length) return 'incomplete';
  if (layout === 'absent') return 'unknown';

  try {
    assertOrderedReferences(
      { fullConversationHeadersOnly: references },
      available,
    );
  } catch {
    return 'incomplete';
  }

  if (references.length) {
    if (
      !references.every(
        (r) =>
          r &&
          typeof r === 'object' &&
          [1, 2].includes((r as { type: number }).type),
      )
    )
      return 'unknown';

    for (const ref of references as { bubbleId: string; type: number }[]) {
      const type = messageTypes.get(ref.bubbleId);

      if (type === undefined) return 'unknown';
      if (type !== ref.type) return 'incomplete';
    }

    return 'ready';
  }

  // An empty visible list with orphan records/state is not a proven empty chat.
  if (
    available.size ||
    resources ||
    (typeof fields.conversationState === 'string' &&
      fields.conversationState !== '~' &&
      fields.conversationState !== '')
  )
    return 'unknown';

  return 'empty';
}
