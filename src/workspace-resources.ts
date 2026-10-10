import { readdir } from 'node:fs/promises';
import { attachmentDirectory } from './attachments';
import { bubbleRange, sqlText } from './core';
import { execSql } from './sqlite';
import type { TransferContext, WorkspaceEntry } from './types';

/** Image files beyond this are refused instead of scanned. */
const IMAGE_PROOF_LIMIT = 32;

/** UUID embedded in a workspace image filename. */
const UUID_IN_NAME =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * Refuse workspace removal when another chat's messages reference an image in this directory.
 * Only known composer ids are probed. An unknown dependency is a refusal, not a guess.
 */
export async function foreignImageRefusal(
  /** Transfer hooks, timeouts, and cancellation. */
  ctx: TransferContext,
  /** Workspace directory proposed for removal. */
  entry: WorkspaceEntry,
  /** Composer ids that belong to this workspace and may reference its images. */
  ownIds: string[],
): Promise<string | undefined> {
  let names: string[];

  try {
    names = await readdir(attachmentDirectory(entry));
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? error.code
        : undefined;

    if (code === 'ENOENT') return undefined;

    throw error;
  }

  const uuids = [
    ...new Set(
      names
        .flatMap((name) => name.match(UUID_IN_NAME) ?? [])
        .map((id) => id.toLowerCase()),
    ),
  ];

  if (!uuids.length) return undefined;
  if (uuids.length > IMAGE_PROOF_LIMIT)
    return 'This workspace has too many image files to prove they are not used by another chat. Nothing was deleted.';

  const listed = await execSql({
    ...ctx,
    database: entry.globalDbPath,
    readOnly: true,
    sql: `SELECT key FROM cursorDiskKV WHERE key >= 'composerData:' AND key < 'composerData;';`,
  });

  const own = new Set(ownIds);

  const others = listed
    .split('\n')
    .map((key) => key.trim())
    .filter(
      (key) =>
        key.startsWith('composerData:') &&
        !key.slice('composerData:'.length).includes(':'),
    )
    .map((key) => key.slice('composerData:'.length))
    .filter((id) => id && !own.has(id));

  for (const id of others) {
    let range: { lower: string; upper: string };

    try {
      range = bubbleRange(id);
    } catch (error) {
      if (error instanceof TypeError) continue;

      throw error;
    }

    for (const uuid of uuids) {
      const hit = await execSql({
        ...ctx,
        database: entry.globalDbPath,
        readOnly: true,
        sql: `SELECT 1 FROM cursorDiskKV WHERE key >= ${sqlText(range.lower)} AND key < ${sqlText(range.upper)} AND instr(lower(CAST(value AS TEXT)), ${sqlText(uuid)}) LIMIT 1;`,
      });

      if (hit.trim())
        return 'This workspace contains an image referenced by another chat. Nothing was deleted.';
    }
  }

  return undefined;
}
