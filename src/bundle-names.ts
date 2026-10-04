import path from 'node:path';
import { ORDINAL_WIDTH } from './bundle-limits';

/** Zero-padded ordinal used for generated archive paths. */
export function ordinalName(
  /** Ordinal to pad. */
  value: number,
): string {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error('Archive ordinal must be a positive integer.');
  }

  return String(value).padStart(ORDINAL_WIDTH, '0');
}

/** `directory/000001.ndjson`. */
export function partPath(
  /** Directory that receives the part. */
  directory: string,
  /** One-based part number. */
  part: number,
): string {
  return path.join(directory, `${ordinalName(part)}.ndjson`);
}

/** Reject a ZIP member name before it is joined onto a directory. */
export function assertArchivePath(name: string): void {
  if (!name || typeof name !== 'string') {
    throw new Error('Archive entry name is missing.');
  }

  if (name.length > 512) throw new Error('Archive entry name is too long.');

  if (
    name.startsWith('/') ||
    name.startsWith('\\') ||
    /^[A-Za-z]:/.test(name) ||
    name.startsWith('\\\\')
  ) {
    throw new Error('Archive entry path is absolute.');
  }

  if (name.includes('\\') || name.includes('\0')) {
    throw new Error('Archive entry path contains a forbidden character.');
  }

  const parts = name.split('/');

  if (
    parts.some(
      (/** One path segment. */ part) =>
        !part || part === '.' || part === '..' || part !== part.trim(),
    )
  ) {
    throw new Error('Archive entry path is not a safe relative path.');
  }
}

/** True when two entry names would collide on a case-insensitive volume. */
export function sameArchiveName(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}
