import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import path from 'node:path';
import { MAX_RESOURCE_BYTES, resourceError as fail } from './resource-bytes';

/** Attempts used to obtain a stable filesystem artifact snapshot. */
export const ARTIFACT_READ_ATTEMPTS = 2;

/** A stable, bounded snapshot of one allowlisted filesystem artifact. */
export interface ArtifactSource {
  /** Validated basename, never a source path. */
  filename: string;
  bytes: Buffer;
  byteLength: number;
  sha256: string;
}

/** Testable policy for one artifact family. */
export interface ArtifactSourceOptions {
  root: string;
  filename: string;
  isBasename: (filename: string) => boolean;
  /** Human-readable family name used in errors. */
  kind: string;
  maxBytes?: number;
  signal?: AbortSignal;
  /** Called after an attempt read; useful for deterministic race tests. */
  afterReadAttempt?: (attempt: number) => void | Promise<void>;
}

interface Identity {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

/** Identity fields that change when a file is replaced or modified. */
function identity(st: BigIntStats): Identity {
  return {
    dev: st.dev,
    ino: st.ino,
    size: st.size,
    mtimeNs: st.mtimeNs,
    ctimeNs: st.ctimeNs,
  };
}

/** True only for the same physical file and byte version. */
function sameIdentity(a: Identity, b: Identity): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}

/** Missing paths are absence; every other I/O failure remains observable. */
function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/**
 * Read an allowlisted basename beneath a real directory without following a
 * symlink. The opened file is streamed with a hard limit and accepted only if
 * its identity is unchanged before and after the read. One concurrent change
 * is retried from a fresh lstat/open pair.
 */
export async function readArtifactSource(
  opts: ArtifactSourceOptions,
): Promise<ArtifactSource | null> {
  if (
    !opts.root ||
    path.basename(opts.filename) !== opts.filename ||
    !opts.isBasename(opts.filename)
  ) {
    fail('INVALID_RESOURCE', `Invalid ${opts.kind} filename.`);
  }

  const maxBytes = opts.maxBytes ?? MAX_RESOURCE_BYTES;
  const source = path.join(opts.root, opts.filename);

  for (let attempt = 0; attempt < ARTIFACT_READ_ATTEMPTS; attempt++) {
    opts.signal?.throwIfAborted();
    let rootStat: BigIntStats;
    let pathStat: BigIntStats;

    try {
      rootStat = await fs.lstat(opts.root, { bigint: true });
      pathStat = await fs.lstat(source, { bigint: true });
    } catch (error) {
      if (missing(error)) return null;

      throw error;
    }

    if (
      rootStat.isSymbolicLink() ||
      !rootStat.isDirectory() ||
      pathStat.isSymbolicLink() ||
      !pathStat.isFile()
    ) {
      return null;
    }

    if (pathStat.size > BigInt(maxBytes)) {
      fail('INVALID_RESOURCE', `${opts.kind} exceeds size limit.`);
    }

    let handle: fs.FileHandle | undefined;

    try {
      handle = await fs.open(
        source,
        constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
      );

      const opened = await handle.stat({ bigint: true });

      if (
        !opened.isFile() ||
        !sameIdentity(identity(pathStat), identity(opened))
      )
        continue;

      const chunks: Buffer[] = [];
      const hash = createHash('sha256');
      let byteLength = 0;

      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        opts.signal?.throwIfAborted();
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);

        byteLength += bytes.length;

        if (byteLength > maxBytes) {
          fail('INVALID_RESOURCE', `${opts.kind} exceeds size limit.`);
        }

        chunks.push(bytes);
        hash.update(bytes);
      }

      await opts.afterReadAttempt?.(attempt);
      const after = await handle.stat({ bigint: true });

      if (
        byteLength !== Number(after.size) ||
        !sameIdentity(identity(opened), identity(after))
      ) {
        continue;
      }

      return {
        filename: opts.filename,
        bytes: Buffer.concat(chunks, byteLength),
        byteLength,
        sha256: hash.digest('hex'),
      };
    } catch (error) {
      if (missing(error)) {
        if (attempt === 0) continue;

        return null;
      }

      throw error;
    } finally {
      await handle?.close();
    }
  }

  fail('INVALID_RESOURCE', `${opts.kind} changed while it was being read.`);
}
