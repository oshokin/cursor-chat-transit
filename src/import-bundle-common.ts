import path from 'node:path';
import type { RecoveryPreview } from './recovery-preview';
import { SqliteSession } from './sqlite-session';
import { transferEvent } from './transfer-events';
import type { ImportResult } from './types';
import { TransferError } from './types';

/** Source and destination identity for one scanned chat. */
export interface ChatRow {
  /** Composer id in the bundle. */
  sourceId: string;
  /** Composer id that will be written. */
  targetId: string;
  /** Snapshot hash used for the import decision. */
  hash: string;
  /** `complete` when the blob closure is present, otherwise history only. */
  quality: 'complete' | 'history-only';
}

/** Chats grouped by the import decision. */
export interface Plan {
  /** Ordinals of chats that will be inserted. */
  create: number[];
  /** Chats the operator chose not to import. */
  skipped: ImportResult['skippedChats'];
  /** Chats already present at the same snapshot. */
  already: ImportResult['alreadyImportedChats'];
  /** Chats whose snapshot differs from the destination. */
  newVersions: ImportResult['newVersionChats'];
  /** Chats recovered from a previous interrupted import. */
  restored: NonNullable<ImportResult['restoredChats']>;
}

/** Load one scanned chat row from the work database. */
export async function oneChat(
  /** Temporary index of the bundle. */
  work: SqliteSession,
  /** Catalog ordinal of this chat. */
  ordinal: number,
): Promise<ChatRow> {
  const row = json<{
    source_id: string;
    target_id: string;
    /** Canonical snapshot hash. */
    snapshot_hash: string;
    /** complete or history-only. */
    quality: 'complete' | 'history-only';
  }>(
    (
      await work.exec(
        `SELECT json_object('source_id', source_id, 'target_id', target_id, 'snapshot_hash', snapshot_hash, 'quality', quality) FROM chat WHERE ordinal = ${ordinal};`,
      )
    ).trim(),
  );

  return {
    sourceId: row.source_id,
    targetId: row.target_id,
    hash: row.snapshot_hash,
    quality: row.quality,
  };
}

/** ImportResult counts from the plan and the chats that were written. */
export function resultFrom(
  /** Chats grouped by the import decision. */
  plan: Plan,
  /** Destination composer ids written in this run. */
  written: string[],
  /** Destination ids imported as history-only. */
  historyOnlyIds: string[],
): ImportResult {
  return {
    imported: written.length,
    complete: written.length - historyOnlyIds.length,
    historyOnly: historyOnlyIds.length,
    skipped: plan.skipped.length,
    alreadyImported: plan.already.length,
    alreadyPresent: plan.already.length,
    newVersions: plan.newVersions.length,
    restored: plan.restored.length,
    incomplete: 0,
    composerIds: written,
    historyOnlyIds,
    skippedChats: plan.skipped,
    alreadyImportedChats: plan.already,
    newVersionChats: plan.newVersions,
    restoredChats: plan.restored,
  };
}

/** NEEDS_ATTENTION for a chat left in a pending import. */
export function pendingProblem(
  /** Destination composer left by the interrupted import. */
  targetId: string,
  /** Source composer id named in the diagnostic. */
  sourceId: string,
): TransferError {
  const err = attention('pending-import', sourceId);

  err.detail = `pending phase pendingTarget=${targetId} source=${sourceId}`;

  return err;
}

/** True when a chat body cannot be remapped and may be skipped. */
export function isSkippableChat(
  /** Failure raised while reading one chat. */
  err: unknown,
): boolean {
  const message = err instanceof Error ? err.message : '';

  return (
    (err instanceof TransferError && err.code === 'MISSING_MESSAGE') ||
    message.includes('is not an object') ||
    message.includes('unsupported bubble payload')
  );
}

/** NEEDS_ATTENTION error that names the source chat. */
export function attention(
  /** Short machine reason stored on the error. */
  reason: string,
  /** Source composer id named in the diagnostic. */
  sourceId: string,
): TransferError {
  const err = new TransferError(
    'The previous import needs checking. No new copies were created.',
  );

  err.code = 'NEEDS_ATTENTION';
  err.detail = `${reason} source=${sourceId}`;

  return err;
}

/** Require a JSON object. */
export function asObject(
  /** Value that must be a JSON object. */
  value: unknown,
  /** Name used when the value is rejected. */
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is not an object.`);
  }

  return value as Record<string, unknown>;
}

/** Parse one NDJSON line. */
export function json<T>(
  /** One JSON object written by SQLite `json_object`. */
  line: string,
): T {
  return JSON.parse(line) as T;
}

/** Require an array of strings. */
export function stringList(
  /** Value that must be a list of strings. */
  value: unknown,
): string[] {
  if (value === undefined) return [];

  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new TransferError('composer id list is not an array of strings.');
  }

  return value.slice() as string[];
}

/** Sorted `.ndjson` paths, or none when the directory is missing. */
export async function ndjsonFiles(
  /** Directory that may not exist yet. */
  dir: string,
): Promise<string[]> {
  const { readdir } = await import('node:fs/promises');

  try {
    return (await readdir(dir))
      .filter((name) => name.endsWith('.ndjson'))
      .sort()
      .map((name) => path.join(dir, name));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];

    throw err;
  }
}

/** Summarize the exact staged plan; full reasons remain in the operation log. */
export async function recoveryPreview(
  /** Temporary index of the scanned bundle. */
  work: SqliteSession,
  /** Chats grouped by the import decision. */
  plan: Plan,
): Promise<RecoveryPreview> {
  const counts = json<{
    /** Complete chats staged for insert. */
    complete: number;
    /** History-only chats staged for insert. */
    historyOnly: number;
  }>(
    await work.exec(
      "SELECT json_object('complete',coalesce(sum(quality='complete'),0),'historyOnly',coalesce(sum(quality='history-only'),0)) FROM chat WHERE decision='create';",
    ),
  );

  const missing = json<Record<string, number>>(
    await work.exec(
      "SELECT json_group_object(kind,n) FROM (SELECT json_extract(canonical,'$.kind') kind,count(*) n FROM dep WHERE json_extract(canonical,'$.sha256') IS NULL GROUP BY kind);",
    ),
  );

  for (const chat of plan.skipped)
    transferEvent({
      action: `Skip unavailable chat: ${chat.reason}`,
      status: 'info',
      chatId: chat.composerId,
      chatName: chat.name,
    });

  return {
    ...counts,
    skipped: plan.skipped.length,
    alreadyImported: plan.already.length,
    missingResources: missing,
    details: plan.skipped
      .slice(0, 5)
      .map(
        (chat) =>
          `${(chat.name || chat.composerId).slice(0, 120)}: ${chat.reason.slice(0, 300)}`,
      ),
  };
}
