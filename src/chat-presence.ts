import { bubbleRange, sqlText } from './core';
import { execSql } from './sqlite';
import { readKvText } from './db-read';
import { MAX_SQLITE_VALUE_BYTES } from './bundle-limits';
import { parseBoundedJson } from './record-json';
import { splitConversation } from './import-policy';
import { blobKeysFromComposerBody } from './chat-dependencies';
import { planFilenamesFromChat } from './plans';
import { canvasFilenamesFromChat } from './canvases';
import type { SqliteConn } from './types';

/** Presence is sufficient to retain history, but never proves transfer health. */
export type ChatPresence = 'present' | 'empty' | 'missing' | 'unknown';

/** Prove absence cheaply. Never load message bodies, blob graphs or attachments. */
export async function inspectChatPresence(
  conn: SqliteConn,
  id: string,
): Promise<ChatPresence> {
  conn.signal?.throwIfAborted();
  const range = bubbleRange(id);

  const any = await execSql({
    ...conn,
    sql: `SELECT 1 FROM cursorDiskKV WHERE key >= ${sqlText(range.lower)} AND key < ${sqlText(range.upper)} LIMIT 1;`,
  });

  // Even orphaned or unreadable message rows must keep the workspace visible.
  if (any.trim()) return 'present';

  const size = await execSql({
    ...conn,
    sql: `SELECT length(CAST(value AS BLOB)) FROM cursorDiskKV WHERE key=${sqlText(`composerData:${id}`)};`,
  });

  if (!size.trim()) return 'missing';
  if (Number(size.trim()) > MAX_SQLITE_VALUE_BYTES) return 'unknown';

  const raw = await readKvText(conn, `composerData:${id}`);

  if (raw === null) return 'missing';
  const parsed = parseBoundedJson(Buffer.from(raw, 'utf8'), `composer ${id}`);

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    return 'unknown';
  const body = parsed as Record<string, unknown>;

  if (body.composerId !== undefined && body.composerId !== id) return 'unknown';
  const conversation = splitConversation(body);

  if (conversation.state === 'absent') return 'unknown';
  if (conversation.items.length) return 'present';
  if (
    body.conversationState !== undefined &&
    body.conversationState !== null &&
    body.conversationState !== '~'
  )
    return 'unknown';
  if (blobKeysFromComposerBody(raw).status !== 'ok') return 'unknown';
  if (
    planFilenamesFromChat(raw, []).length ||
    canvasFilenamesFromChat(raw, []).length
  )
    return 'unknown';

  return 'empty';
}
