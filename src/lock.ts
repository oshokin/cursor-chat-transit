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

    return code !== 'ESRCH';
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

  const error = recoveryRequired(
    `A previous Cursor Chat Transit operation did not finish (pid ${pid}). Use Clear stale lock, then retry. Lock: ${lockPath}`,
  );

  const record = JSON.parse(text) as { token?: unknown };

  if (
    typeof record.token === 'string' &&
    /^[a-f0-9]{32}$/.test(record.token) &&
    pid > 0
  ) {
    error.detail = JSON.stringify({ lockPath, token: record.token, pid });
  }

  throw error;
}

/** Publish a finished owner record. The lock name appears only after the bytes exist. */
async function claimLock(
  lockPath: string,
  payload: string,
  token: string,
): Promise<void> {
  const temporary = `${lockPath}.${token}.partial`;

  try {
    await fs.promises.writeFile(temporary, payload, {
      flag: 'wx',
      mode: 0o600,
    });

    const handle = await fs.promises.open(temporary, 'r+');

    try {
      await handle.sync();
    } finally {
      await handle.close();
    }

    await fs.promises.link(temporary, lockPath);
  } finally {
    await fs.promises.unlink(temporary).catch(() => undefined);
  }
}

/** Exclusive transfer lock. A leftover file is never unlinked automatically. */
export async function acquireLock(
  lockDir: string,
  name: string,
): Promise<LockHandle> {
  await fs.promises.mkdir(lockDir, { recursive: true });
  const lockPath = path.join(lockDir, `${name}.lock`);

  if (fs.existsSync(`${lockPath}.recovery`))
    throw locked('Transfer lock recovery is in progress.');
  const token = randomBytes(16).toString('hex');

  const payload = JSON.stringify({
    pid: process.pid,
    token,
    startedAt: Date.now(),
  });

  try {
    await claimLock(lockPath, payload, token);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;

    try {
      await refuseExistingLock(lockPath);
    } catch (inner) {
      if ((inner as NodeJS.ErrnoException).code !== 'ENOENT') throw inner;

      try {
        await claimLock(lockPath, payload, token);
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

/** Identity captured when an operation refuses a dead owner's lock. */
export interface StaleLock {
  /** Absolute path of the lock file. */
  lockPath: string;
  /** Token recorded in that file. */
  token: string;
  /** Pid recorded as the owner. */
  pid: number;
}

/** Remove only the same validated lock whose owner is still absent. No SQLite files are touched. */
export async function clearStaleLock(expected: StaleLock): Promise<void> {
  if (
    !path.isAbsolute(expected.lockPath) ||
    !expected.lockPath.endsWith('.lock') ||
    !/^[a-f0-9]{32}$/.test(expected.token) ||
    !Number.isSafeInteger(expected.pid) ||
    expected.pid <= 0
  ) {
    throw new Error('Invalid stale lock identity.');
  }

  const guard = `${expected.lockPath}.recovery`;

  await fs.promises.mkdir(guard);

  try {
    const stat = await fs.promises.lstat(expected.lockPath);

    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096)
      throw new Error('Transfer lock is not a regular lock file.');

    const current = JSON.parse(
      await fs.promises.readFile(expected.lockPath, 'utf8'),
    ) as StaleLock;

    if (
      current.token !== expected.token ||
      current.pid !== expected.pid ||
      isAlive(current.pid)
    ) {
      throw locked(
        'Lock ownership changed or its process is still running. Nothing was removed.',
      );
    }

    await fs.promises.unlink(expected.lockPath);
  } finally {
    await fs.promises.rmdir(guard);
  }
}
