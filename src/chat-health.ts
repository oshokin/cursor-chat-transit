import { readChatForExport } from './export-chat';
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
  /** Transfer hooks, timeouts, and cancellation. */
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
        /** Ignore chat start during a metadata check. */
        async beginChat() {},
        /** Remember composer fields and the conversation layout. */
        async writeComposer(
          /** Composer fields captured for the check. */
          value,
          /** Whether the conversation array was present. */
          conversation,
        ) {
          ctx.signal?.throwIfAborted();
          fields = value;
          layout = conversation;
          if (value.composerId !== undefined && value.composerId !== id)
            throw new Error('Composer identity mismatch.');
        },
        /** Remember one ordered conversation reference. */
        async writeConversation(
          /** One conversation element, in source order. */
          value,
        ) {
          ctx.signal?.throwIfAborted();
          references.push(value);
        },
        /** Remember one bubble id and its type. */
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
        /** Count one resource without writing it. */
        async writeResource() {
          ctx.signal?.throwIfAborted();
          resources++;
        },
        /** Inspection must not write blob files. */
        async addBlob() {
          throw new Error('Inspection must not write files.');
        },
        /** Ignore chat end during a metadata check. */
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
          /** Record type discriminant. */
          [1, 2].includes(
            (
              r as {
                /** Message role, 1 or 2. */
                type: number;
              }
            ).type,
          ),
      )
    )
      return 'unknown';

    for (const ref of references as {
      /** Id of the ordered message. */
      bubbleId: string;
      /** Message role stored on the header. */
      type: number;
    }[]) {
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
