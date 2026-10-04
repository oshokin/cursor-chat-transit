import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeObjectBundle } from './bundle-from-object';
import { importFromBundle } from './import-bundle';
import {
  TransferError,
  type ImportResult,
  type TransferContext,
  type WorkspaceEntry,
} from './types';

/**
 * Import an in-memory fixture by writing a v4 archive and reading that archive.
 * On-disk JSON exports are not accepted. Callers that already have a ZIP use
 * `importFromBundle`.
 */
export async function importFromObject(
  /** Transfer hooks, timeouts, and cancellation. */
  ctx: TransferContext,
  obj: unknown,
  workspace: WorkspaceEntry,
  options?: {
    /** When true, recover chats that are missing optional resources. */
    allowPartial?: boolean;
    /** Directory that holds the per-target import journal. */
    journalDir?: string;
    /** Directory that holds the inter-process transfer lock. */
    lockDir?: string;
  },
): Promise<ImportResult> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cct-fixture-zip-'));
  const zipPath = path.join(dir, 'fixture.cursor-chat.zip');

  try {
    await writeFixtureBundle(zipPath, obj, options?.allowPartial === true);

    return await importFromBundle(ctx, zipPath, workspace, options);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Write the fixture. A wholly unreadable chat is an empty import when recovery is on. */
async function writeFixtureBundle(
  zipPath: string,
  obj: unknown,
  /** Keep readable history when optional resources are missing. */
  allowPartial: boolean,
): Promise<void> {
  try {
    await writeObjectBundle(zipPath, obj);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    if (!allowPartial || !/not valid JSON/i.test(message)) throw err;

    const empty = new TransferError('Nothing to import.');

    empty.code = 'NOTHING_TO_IMPORT';

    throw empty;
  }
}
