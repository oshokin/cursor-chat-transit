import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

/** Immutable content-addressed storage used by bundle writers and readers. */
export interface BlobStore {
  path(sha256: string): string;
  putFile(
    sha256: string,
    sourcePath: string,
    signal?: AbortSignal,
  ): Promise<void>;
}

/** Filesystem layout `root/xx/<sha256>.bin`. */
export class FileBlobStore implements BlobStore {
  constructor(private readonly root: string) {}

  path(sha256: string): string {
    assertSha256(sha256);

    return path.join(this.root, sha256.slice(0, 2), `${sha256}.bin`);
  }

  async putFile(
    sha256: string,
    sourcePath: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const destination = this.path(sha256);

    try {
      await mkdir(path.dirname(destination), { recursive: true });

      await pipeline(
        createReadStream(sourcePath),
        createWriteStream(destination, { flags: 'wx', mode: 0o600 }),
        { signal },
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
}

function assertSha256(value: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error('Invalid blob hash.');
}
