import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resourceError } from './resource-bytes';

/** True when the resolved path stays under `root`. */
export function pathInside(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  const prefix = resolvedRoot.endsWith(path.sep)
    ? resolvedRoot
    : resolvedRoot + path.sep;
  return resolved === resolvedRoot || resolved.startsWith(prefix);
}

/** True when an existing path does not symlink out of `root`. */
export function staysInRoot(root: string, candidate: string): boolean {
  if (!pathInside(root, candidate)) return false;
  try {
    const lst = fs.lstatSync(candidate);
    if (!lst.isSymbolicLink()) return true;
    const realRoot = fs.realpathSync(root);
    const real = fs.realpathSync(candidate);
    const prefix = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
    return real === realRoot || real.startsWith(prefix);
  } catch {
    return false;
  }
}

/** Shared image/plan install primitive; wrappers own filenames and formats. */
export async function writeFileNoClobber(
  root: string,
  dest: string,
  bytes: Buffer,
  conflictMessage: string,
): Promise<void> {
  if (
    !pathInside(root, dest) ||
    path.resolve(path.dirname(dest)) !== path.resolve(root)
  ) {
    resourceError('INVALID_RESOURCE', 'Resource path escapes its directory.');
  }
  await fs.promises.mkdir(root, { recursive: true });
  const dir = await fs.promises.lstat(root);
  if (dir.isSymbolicLink() || !dir.isDirectory()) {
    resourceError(
      'INVALID_RESOURCE',
      'Resource directory is not a regular directory.',
    );
  }
  /** Confirm an existing dest file already holds the same bytes. */
  const verifyExisting = async () => {
    const entry = await fs.promises.lstat(dest);
    if (
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      !(await fs.promises.readFile(dest)).equals(bytes)
    ) {
      resourceError('RESOURCE_CONFLICT', conflictMessage);
    }
  };
  try {
    await verifyExisting();
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const tmp = `${dest}.${randomUUID()}.partial`;
  try {
    await fs.promises.writeFile(tmp, bytes, { flag: 'wx', mode: 0o600 });
    const handle = await fs.promises.open(tmp, 'r+');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.promises.link(tmp, dest);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      await verifyExisting();
    }
  } finally {
    await fs.promises.unlink(tmp).catch(() => undefined);
  }
}
