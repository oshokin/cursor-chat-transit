import { readChatForExport } from './export-chat';
import { assertOrderedReferences } from './chat-json';
import { conversationStateIds } from './conversation-state';
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
  let rootUserMessages = 0;

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
            (bubble.bubbleId !== undefined &&
              bubble.bubbleId !== bubbleId &&
              !(
                typeof bubble.bubbleId === 'string' &&
                bubbleId.startsWith(`${bubble.bubbleId}/`)
              )) ||
            (bubble.composerId !== undefined && bubble.composerId !== id)
          )
            throw new Error('Message identity mismatch.');
          available.add(bubbleId);
          messageTypes.set(bubbleId, bubble.type);
          if (!bubbleId.includes('/') && bubble.type === 1) rootUserMessages++;
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

  const structuralIssue = await inspectCurrentStructure(
    conn,
    id,
    fields,
    available,
    header,
    references.length === 0 && rootUserMessages > 0,
  );

  if (structuralIssue) {
    ctx.onNote?.(`Incomplete chat ${header.name || id}: ${structuralIssue}`);

    return 'incomplete';
  }

  try {
    assertOrderedReferences(
      { fullConversationHeadersOnly: references },
      available,
    );
  } catch {
    ctx.onNote?.(
      `Incomplete chat ${header.name || id}: a referenced message is not stored`,
    );

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

      if (type !== ref.type) {
        ctx.onNote?.(
          `Incomplete chat ${header.name || id}: message role does not match the stored record`,
        );

        return 'incomplete';
      }
    }

    return 'ready';
  }

  // Current Cursor may keep the ordered history in conversationState while the
  // compatibility header array is empty. Root user bubbles prove useful history;
  // slash-suffixed rows are nested stream/tool records, not conversation turns.
  if (rootUserMessages > 0) return 'ready';

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

/** Validate v13-v18 opaque ids, nested bubble ownership, and explicit family links. */
async function inspectCurrentStructure(
  conn: SqliteConn,
  composerId: string,
  fields: Record<string, unknown>,
  available: ReadonlySet<string>,
  header: ComposerHeader,
  stateBacked: boolean,
): Promise<string | undefined> {
  const requiredComposers = familyComposerIds(fields, header);
  const version = fields._v;
  const state = fields.conversationState;

  let stateIds = new Set<string>();

  if (
    typeof version === 'number' &&
    Number.isInteger(version) &&
    version >= 13 &&
    version <= 18 &&
    typeof state === 'string' &&
    state.trim() !== ''
  ) {
    stateIds = conversationStateIds(state);
  }

  if (stateBacked && version === 18) {
    if (!stateIds.has(composerId))
      return 'conversation state does not reference its current composer';

    for (const bubbleId of available)
      if (!bubbleId.includes('/') && !stateIds.has(bubbleId))
        return `conversation state does not reference stored root ${bubbleId}`;
  }

  requiredComposers.delete(composerId);

  for (const id of requiredComposers) {
    if (await dbComposerExists(conn, id)) continue;

    return `conversation state or family metadata references missing id ${id}`;
  }

  return undefined;
}

/** Composer ids named by the public family metadata on the body or header. */
function familyComposerIds(
  fields: Record<string, unknown>,
  header: ComposerHeader,
): Set<string> {
  const ids = new Set<string>();

  for (const record of [fields, header as Record<string, unknown>]) {
    const children = record.subagentComposerIds;

    if (Array.isArray(children))
      for (const id of children) if (typeof id === 'string') ids.add(id);
    const info = record.subagentInfo;

    if (!info || typeof info !== 'object' || Array.isArray(info)) continue;

    for (const key of ['parentComposerId', 'rootParentConversationId']) {
      const id = (info as Record<string, unknown>)[key];

      if (typeof id === 'string') ids.add(id);
    }
  }

  return ids;
}

/** Whether a referenced composer body exists in the same global database view. */
async function dbComposerExists(
  conn: SqliteConn,
  composerId: string,
): Promise<boolean> {
  const found = await execSql({
    ...conn,
    sql: `SELECT 1 FROM cursorDiskKV WHERE key=${sqlText(`composerData:${composerId}`)} LIMIT 1;`,
  });

  return Boolean(found.trim());
}
