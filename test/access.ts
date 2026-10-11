import { execFile } from 'node:child_process';
import { chmod } from 'node:fs/promises';

/** Apply or remove one Windows deny entry without a shell. */
function icacls(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('icacls', args, { windowsHide: true }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

/**
 * Stop the current user from reading or traversing `target`.
 * Windows ignores Unix mode bits, so the deny ACE is what makes stat fail.
 * Changing the ACL stays allowed, which is what `allowAccess` uses.
 */
export async function denyAccess(target: string): Promise<void> {
  if (process.platform !== 'win32') {
    await chmod(target, 0o000);

    return;
  }

  const user = process.env.USERNAME;

  if (!user) throw new Error('USERNAME is required to deny access.');

  await icacls([target, '/deny', `${user}:(OI)(CI)(RX)`]);
}

/** Restore traversal after `denyAccess`. */
export async function allowAccess(target: string): Promise<void> {
  if (process.platform !== 'win32') {
    await chmod(target, 0o700);

    return;
  }

  const user = process.env.USERNAME;

  if (!user) throw new Error('USERNAME is required to restore access.');

  await icacls([target, '/remove:d', user]);
}
