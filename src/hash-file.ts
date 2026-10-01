import { transferEvent } from './transfer-events';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';

/** SHA-256 of a file, read in chunks. */
export async function hashFile(
  filePath: string,
  signal?: AbortSignal,
): Promise<{
  /** Lowercase hex digest. */
  sha256: string;
  /** Byte length. */
  bytes: number;
}> {
  transferEvent({
    action: 'Verify file checksum',
    status: 'started',
    path: filePath,
  });

  const hash = createHash('sha256');
  let bytes = 0;

  try {
    await pipeline(
      createReadStream(filePath, { signal }),
      new Transform({
        /** Hash each chunk and count bytes. */
        transform(chunk, _enc, cb) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);

          bytes += buf.length;
          hash.update(buf);
          cb();
        },
      }),
    );
  } catch (error) {
    transferEvent({
      action: 'Verify file checksum',
      status: 'failed',
      path: filePath,
    });

    throw error;
  }

  transferEvent({
    action: 'Verify file checksum',
    status: 'completed',
    path: filePath,
    bytes,
  });

  return { sha256: hash.digest('hex'), bytes };
}

/** Write lowercase hex of `source` without building one giant hex string. */
export async function writeHexFile(
  source: string,
  dest: string,
): Promise<void> {
  const input = createReadStream(source, { highWaterMark: 1024 * 1024 });
  const handle = await open(dest, 'wx');

  try {
    for await (const chunk of input) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);

      await handle.write(buf.toString('hex'));
    }

    await handle.sync();
  } finally {
    await handle.close();
  }
}
