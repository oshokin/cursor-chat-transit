import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Parent directory for one operation's private scratch files.
 * An empty setting uses the system temporary directory. Callers never delete this parent.
 */
export function operationTempParent(configured?: string): string {
  if (!configured) return os.tmpdir();

  return configured;
}

/**
 * Create a random child of the operation scratch parent.
 * Cleanup must delete only the returned directory.
 */
export async function operationTempDir(
  /** Prefix passed to `mkdtemp`, including the trailing hyphen. */
  prefix: string,
  /** Absolute parent captured for this operation. Empty uses the system temp directory. */
  configured?: string,
): Promise<string> {
  return mkdtemp(path.join(operationTempParent(configured), prefix));
}
