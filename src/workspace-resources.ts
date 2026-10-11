import { readdir } from 'node:fs/promises';
import { attachmentDirectory } from './attachments';
import { bubbleRange, sqlText } from './core';
import { execSql } from './sqlite';
import type { TransferContext, WorkspaceEntry } from './types';

/** Foreign composers or image ids searched in one statement. */
const IMAGE_ID_BATCH = 32;

/** UUID embedded in a workspace image filename. */
const UUID_IN_NAME =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Refuse workspace removal when another chat's messages reference an image in this directory.
 * Orphan bubbles are included. An unknown id or a read error is a refusal, not proof of absence.
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

    return `Cannot confirm image ownership: ${error instanceof Error ? error.message : String(error)}`;
  }

  const unnamed = names.find((name) => !UUID_IN_NAME.test(name));

  if (unnamed)
    return `Cannot confirm image ownership because ${JSON.stringify(unnamed.slice(0, 80))} is not a supported image name. Nothing was deleted.`;

  const uuids = [
    ...new Set(
      names.flatMap((name) => {
        const found = name.match(UUID_IN_NAME);

        return found ? [found[0].toLowerCase()] : [];
      }),
    ),
  ];

  if (!uuids.length) return undefined;

  let foreign: string[];

  try {
    foreign = await foreignComposerIds(ctx, entry, ownIds);
  } catch (error) {
    return `Cannot confirm image ownership: ${error instanceof Error ? error.message : String(error)}`;
  }

  const known: Array<{ id: string; lower: string; upper: string }> = [];

  for (const id of foreign) {
    try {
      const range = bubbleRange(id);

      known.push({ id, lower: range.lower, upper: range.upper });
    } catch (error) {
      if (error instanceof TypeError)
        return `Cannot confirm image ownership because composer id ${JSON.stringify(id.slice(0, 80))} is not a supported format. Nothing was deleted.`;

      throw error;
    }
  }

  try {
    for (let start = 0; start < known.length; start += IMAGE_ID_BATCH) {
      const batch = known.slice(start, start + IMAGE_ID_BATCH);

      const where = batch
        .map(
          (item) =>
            `(key>=${sqlText(item.lower)} AND key<${sqlText(item.upper)}) OR key=${sqlText(`composerData:${item.id}`)}`,
        )
        .join(' OR ');

      for (let image = 0; image < uuids.length; image += IMAGE_ID_BATCH) {
        const needle = uuids
          .slice(image, image + IMAGE_ID_BATCH)
          .map((uuid) => `instr(lower(CAST(value AS TEXT)), ${sqlText(uuid)})`)
          .join(' OR ');

        const hit = await execSql({
          ...ctx,
          database: entry.globalDbPath,
          readOnly: true,
          sql: `SELECT 1 FROM cursorDiskKV WHERE (${where}) AND (${needle}) LIMIT 1;`,
        });

        if (hit.trim())
          return 'This workspace contains an image referenced by another chat. Nothing was deleted.';
      }
    }
  } catch (error) {
    return `Cannot confirm image ownership: ${error instanceof Error ? error.message : String(error)}`;
  }

  return undefined;
}

/** Composer ids stored as bubbles or composer rows and not deleted with this workspace. */
async function foreignComposerIds(
  ctx: TransferContext,
  entry: WorkspaceEntry,
  ownIds: string[],
): Promise<string[]> {
  const own = new Set(ownIds);

  const [composers, bubbles] = await Promise.all([
    execSql({
      ...ctx,
      database: entry.globalDbPath,
      readOnly: true,
      sql: `SELECT key FROM cursorDiskKV WHERE key >= 'composerData:' AND key < 'composerData;';`,
    }),
    execSql({
      ...ctx,
      database: entry.globalDbPath,
      readOnly: true,
      sql: `SELECT DISTINCT substr(key, 10, instr(substr(key, 10), ':') - 1) FROM cursorDiskKV WHERE key >= 'bubbleId:' AND key < 'bubbleId;' AND instr(substr(key, 10), ':') > 0;`,
    }),
  ]);

  const ids = new Set<string>();

  for (const key of composers.split('\n')) {
    const trimmed = key.trim();

    if (!trimmed.startsWith('composerData:')) continue;
    const id = trimmed.slice('composerData:'.length);

    if (!id || id.includes(':') || own.has(id)) continue;
    ids.add(id);
  }

  for (const line of bubbles.split('\n')) {
    const id = line.trim();

    if (!id || own.has(id)) continue;
    ids.add(id);
  }

  return [...ids];
}
