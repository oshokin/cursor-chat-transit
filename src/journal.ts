import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { workspaceKey } from './core';
import type { DatabaseBackupPair, WorkspaceEntry } from './types';

/** Completed mapping from a source snapshot to a target composer id. */
export interface ImportReceipt {
  /** Composer id in the export file. */
  sourceComposerId: string;
  /** Canonical hash of that source snapshot. */
  snapshotHash: string;
  /** Composer id written into this target. */
  targetComposerId: string;
  /** Whether the copy was complete or history-only. */
  quality: 'complete' | 'history-only';
  /** ISO timestamp of a verified completion. */
  completedAt: string;
}

/** One chat in a pending import: expected hashes until verification finishes. */
export interface PendingImportChat {
  /** Composer id in the export file. */
  sourceComposerId: string;
  /** Canonical hash of that source snapshot. */
  snapshotHash: string;
  /** Composer id allocated on this target. */
  targetComposerId: string;
  /** Source-to-destination bubble id pairs. */
  bubbleMap: Array<[string, string]>;
  /** SHA-256 of the rewritten composer body. */
  expectedComposerHash: string;
  /** SHA-256 of each rewritten bubble, keyed by destination bubble id. */
  expectedBubbles: Array<[string, string]>;
  /** Present on new pending records. Absent means the write cannot be fully verified. */
  expectedResources?: Array<{
    /** Resource class in the pending record. */
    kind: 'kv' | 'image' | 'plan' | 'canvas';
    /** Key, image UUID, plan basename, or canvas basename. */
    id: string;
    sha256: string;
  }>;
  /** Whether the pending copy is complete or history-only. */
  quality: 'complete' | 'history-only';
}

/** In-flight import batch: phase, chats, and optional backup paths. */
export interface PendingImport {
  /** Random id for this write attempt. */
  operationId: string;
  /** How far the two-database write has progressed. */
  phase: 'prepared' | 'global-written' | 'workspace-written';
  chats: PendingImportChat[];
  /** Backup paths created before mutation. */
  backups?: DatabaseBackupPair;
}

/** Per-target journal: receipts plus at most one pending batch. */
export interface ImportJournal {
  /** Journal format; only version 1 is readable. */
  version: 1;
  /** Canonical identity of the destination workspace. */
  targetKey: string;
  /** Verified mappings for this target. */
  receipts: ImportReceipt[];
  /** Unfinished batch, if any. */
  pending?: PendingImport;
}

/** Canonical target identity: DB paths + storageId + workspace URI key. */
export async function targetKeyFor(workspace: WorkspaceEntry): Promise<string> {
  const identity = workspace.identity
    ? workspaceKey(workspace.identity.kind, workspace.identity.uri)
    : null;

  return JSON.stringify({
    globalDb: await canonicalPath(workspace.globalDbPath),
    workspaceDb: await canonicalPath(workspace.workspaceDbPath),
    storageId: workspace.storageId,
    workspace: identity,
  });
}

/** Journal filename for this target key, hashed so paths stay short. */
export function journalPathFor(
  /** Directory that holds the receipt database. */
  journalDir: string,
  /** Canonical destination identity. */
  targetKey: string,
): string {
  const digest = createHash('sha256').update(targetKey, 'utf8').digest('hex');

  return path.join(journalDir, `import-v4-${digest.slice(0, 32)}.sqlite`);
}

/** Load a journal or an empty one. Corrupt / unsupported files fail closed. */
export async function loadJournal(
  /** Directory that holds the receipt database. */
  journalDir: string,
  /** Canonical destination identity. */
  targetKey: string,
): Promise<ImportJournal> {
  const { JournalStore } = await import('./journal-db');
  const store = await JournalStore.open({ journalDir, targetKey });

  try {
    return await store.readJournal();
  } finally {
    await store.close();
  }
}

/** Persist a journal through the v4 receipt database. */
export async function saveJournal(
  /** Directory that holds the receipt database. */
  journalDir: string,
  /** Receipt database for this destination. */
  journal: ImportJournal,
): Promise<void> {
  const { JournalStore } = await import('./journal-db');

  await fs.promises.mkdir(journalDir, { recursive: true });

  const store = await JournalStore.open({
    journalDir,
    targetKey: journal.targetKey,
  });

  try {
    await store.replaceJournal(journal);
  } finally {
    await store.close();
  }
}

/** Same-directory temp, write, fsync, rename. */
export async function writeJsonAtomic(
  filePath: string,
  /** JSON value written atomically. */
  value: unknown,
): Promise<void> {
  const dir = path.dirname(filePath);

  await fs.promises.mkdir(dir, { recursive: true });

  const tmp = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );

  const data = Buffer.from(JSON.stringify(value), 'utf8');
  const handle = await fs.promises.open(tmp, 'w', 0o600);

  try {
    await handle.writeFile(data);
    await handle.sync();
  } catch (err) {
    await handle.close().catch(() => undefined);
    await fs.promises.unlink(tmp).catch(() => undefined);

    throw err;
  }

  await handle.close();
  await fs.promises.rename(tmp, filePath);

  try {
    const dirHandle = await fs.promises.open(dir, 'r');

    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
  } catch {
    /* directory fsync is not available on every platform */
  }
}

/** Real path when the file exists; otherwise a resolved absolute path. */
async function canonicalPath(filePath: string): Promise<string> {
  try {
    return await fs.promises.realpath(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

/** Promote an already verified pending batch without retaining its mutable pending record. */
export function completePendingImport(
  /** Receipt database for this destination. */
  journal: ImportJournal,
  completedAt = new Date().toISOString(),
): ImportJournal {
  const pending = journal.pending;

  if (!pending) throw new Error('No pending import to complete.');

  return {
    version: 1,
    targetKey: journal.targetKey,
    receipts: [
      ...journal.receipts,
      ...pending.chats.map((chat) => ({
        sourceComposerId: chat.sourceComposerId,
        snapshotHash: chat.snapshotHash,
        targetComposerId: chat.targetComposerId,
        quality: chat.quality,
        completedAt,
      })),
    ],
  };
}
