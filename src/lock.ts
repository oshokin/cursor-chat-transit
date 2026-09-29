import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { TransferError } from './types';

/** Exclusive lock file plus a release that deletes it only while we still own it. */
export interface LockHandle {
  /** Absolute path of this process's lock file. */
  path: string;
  /** Delete the file only while this handle still owns the token. */
  release(): Promise<void>;
}

/** Return whether `pid` is still running. Unknown kill errors fail closed as alive. */
function isAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'EPERM' || code === 'EACCES';
  }
}

/** TransferError with code LOCKED; callers must not write storage. */
function locked(message: string): TransferError {
  const error = new TransferError(message);
  error.code = 'LOCKED';
  return error;
}

/** Leftover lock: do not write; the user must delete only this file after confirming the owner is gone. */
function recoveryRequired(message: string): TransferError {
  const error = new TransferError(message);
  error.code = 'LOCK_RECOVERY_REQUIRED';
  return error;
}

/** Explain a leftover lock without deleting it. Never starts a write. */
async function refuseExistingLock(lockPath: string): Promise<never> {
  let text: string;
  try {
    text = await fs.promises.readFile(lockPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw err;
    throw recoveryRequired(
      `The transfer lock file is unreadable:\n${lockPath}`,
    );
  }
  if (!text.trim()) {
    throw recoveryRequired(`The transfer lock file is empty:\n${lockPath}`);
  }
  let pid: number | undefined;
  try {
    const existing = JSON.parse(text) as { pid?: unknown };
    if (typeof existing.pid === 'number' && Number.isInteger(existing.pid)) {
      pid = existing.pid;
    }
  } catch {
    throw recoveryRequired(
      `The transfer lock file is unreadable:\n${lockPath}`,
    );
  }
  if (pid === undefined) {
    throw recoveryRequired(
      `The transfer lock file is unreadable:\n${lockPath}`,
    );
  }
  if (isAlive(pid)) {
    throw locked(
      `Another Cursor Chat Transit operation is running (pid ${pid}).`,
    );
  }
  throw recoveryRequired(
    `A previous Cursor Chat Transit operation did not finish (pid ${pid}). ` +
      'Close every Cursor window that uses this storage, confirm that process is gone, ' +
      `then delete only this lock file and retry:\n${lockPath}\n` +
      'Do not delete import journals, backups, or Cursor databases.',
  );
}

/** Exclusive transfer lock. A leftover file is never unlinked automatically. */
export async function acquireLock(
  lockDir: string,
  name: string,
): Promise<LockHandle> {
  await fs.promises.mkdir(lockDir, { recursive: true });
  const lockPath = path.join(lockDir, `${name}.lock`);
  const token = randomBytes(16).toString('hex');
  const payload = JSON.stringify({
    pid: process.pid,
    token,
    startedAt: Date.now(),
  });
  try {
    await fs.promises.writeFile(lockPath, payload, { flag: 'wx', mode: 0o600 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    try {
      await refuseExistingLock(lockPath);
    } catch (inner) {
      if ((inner as NodeJS.ErrnoException).code !== 'ENOENT') throw inner;
      try {
        await fs.promises.writeFile(lockPath, payload, {
          flag: 'wx',
          mode: 0o600,
        });
      } catch (retry) {
        if ((retry as NodeJS.ErrnoException).code !== 'EEXIST') throw retry;
        await refuseExistingLock(lockPath);
      }
    }
  }
  let released = false;
  return {
    path: lockPath,
    /** Idempotent: a second call or a stolen file is a no-op. */
    async release() {
      if (released) return;
      released = true;
      try {
        const text = await fs.promises.readFile(lockPath, 'utf8');
        const existing = JSON.parse(text) as { token?: unknown };
        if (existing.token !== token) return;
        await fs.promises.unlink(lockPath);
      } catch {
        /* ignore */
      }
    },
  };
}
