import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { workspaceKey } from './core';
import {
  TransferError,
  type DatabaseBackupPair,
  type WorkspaceEntry,
} from './types';

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
    kind: 'kv' | 'image' | 'plan';
    /** Key, image UUID, or plan basename. */
    id: string;
    /** SHA-256 of the bytes that must still be present. */
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
  /** Chats in this batch. */
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
export function journalPathFor(journalDir: string, targetKey: string): string {
  const digest = createHash('sha256').update(targetKey, 'utf8').digest('hex');
  return path.join(journalDir, `import-${digest.slice(0, 32)}.json`);
}

/** Load a journal or an empty one. Corrupt / unsupported files fail closed. */
export async function loadJournal(
  journalDir: string,
  targetKey: string,
): Promise<ImportJournal> {
  const filePath = journalPathFor(journalDir, targetKey);
  let raw: string;
  try {
    raw = await fs.promises.readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 1, targetKey, receipts: [] };
    }
    throw journalError('Import journal could not be read.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw journalError('Import journal is not valid JSON.');
  }
  if (!isJournal(parsed)) {
    throw journalError('Import journal version is unsupported or damaged.');
  }
  if (parsed.targetKey !== targetKey) {
    throw journalError('Import journal does not match this workspace.');
  }
  return parsed;
}

/** Persist a journal through the same-directory atomic write. */
export async function saveJournal(
  journalDir: string,
  journal: ImportJournal,
): Promise<void> {
  const filePath = journalPathFor(journalDir, journal.targetKey);
  await writeJsonAtomic(filePath, journal);
}

/** Same-directory temp, write, fsync, rename. */
export async function writeJsonAtomic(
  filePath: string,
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

/** Structural check for a version-1 journal object. */
function isJournal(value: unknown): value is ImportJournal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const rec = value as Record<string, unknown>;
  if (rec.version !== 1 || typeof rec.targetKey !== 'string') return false;
  if (!Array.isArray(rec.receipts)) return false;
  for (const row of rec.receipts) {
    if (!isReceipt(row)) return false;
  }
  if (rec.pending !== undefined && !isPending(rec.pending)) return false;
  return true;
}

/** Structural check for a completed import receipt. */
function isReceipt(value: unknown): value is ImportReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const rec = value as Record<string, unknown>;
  return (
    typeof rec.sourceComposerId === 'string' &&
    typeof rec.snapshotHash === 'string' &&
    typeof rec.targetComposerId === 'string' &&
    (rec.quality === 'complete' || rec.quality === 'history-only') &&
    typeof rec.completedAt === 'string'
  );
}

/** Structural check for a pending import batch. */
function isPending(value: unknown): value is PendingImport {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const rec = value as Record<string, unknown>;
  if (typeof rec.operationId !== 'string') return false;
  if (
    rec.phase !== 'prepared' &&
    rec.phase !== 'global-written' &&
    rec.phase !== 'workspace-written'
  ) {
    return false;
  }
  if (
    !Array.isArray(rec.chats) ||
    rec.chats.some((chat) => !isPendingChat(chat))
  ) {
    return false;
  }
  if (rec.backups !== undefined) {
    if (!rec.backups || typeof rec.backups !== 'object') return false;
    const backups = rec.backups as Record<string, unknown>;
    if (
      typeof backups.global !== 'string' ||
      typeof backups.workspace !== 'string'
    ) {
      return false;
    }
  }
  return true;
}

/** Structural check for one expected kv, image, or plan checksum. */
function isPendingResource(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const rec = value as Record<string, unknown>;
  return (
    (rec.kind === 'kv' || rec.kind === 'image' || rec.kind === 'plan') &&
    typeof rec.id === 'string' &&
    typeof rec.sha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(rec.sha256)
  );
}

/** Structural check for one pending chat record. */
function isPendingChat(value: unknown): value is PendingImportChat {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const rec = value as Record<string, unknown>;
  if (
    typeof rec.sourceComposerId !== 'string' ||
    typeof rec.snapshotHash !== 'string' ||
    typeof rec.targetComposerId !== 'string' ||
    !Array.isArray(rec.bubbleMap) ||
    !rec.bubbleMap.every(isStringPair) ||
    typeof rec.expectedComposerHash !== 'string' ||
    !Array.isArray(rec.expectedBubbles) ||
    !rec.expectedBubbles.every(isStringPair) ||
    (rec.quality !== 'complete' && rec.quality !== 'history-only')
  ) {
    return false;
  }
  if (rec.expectedResources === undefined) return true;
  return (
    Array.isArray(rec.expectedResources) &&
    rec.expectedResources.every(isPendingResource)
  );
}

/** Two-string tuple used for bubble maps and expected hashes. */
function isStringPair(value: unknown): value is [string, string] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === 'string' &&
    typeof value[1] === 'string'
  );
}

/** Real path when the file exists; otherwise a resolved absolute path. */
async function canonicalPath(filePath: string): Promise<string> {
  try {
    return await fs.promises.realpath(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

/** Fail closed: a damaged journal must not authorise a write. */
function journalError(message: string): TransferError {
  const err = new TransferError(message);
  err.code = 'JOURNAL_INVALID';
  return err;
}

/** Promote an already verified pending batch without retaining its mutable pending record. */
export function completePendingImport(
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
