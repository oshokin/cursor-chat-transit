import { transferEvent } from './transfer-events';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
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
      fs.createReadStream(filePath, { signal }),
      new Transform({
        /** Hash each chunk and count bytes. */
        transform(
          chunk,
          /** Encoding ignored by this hash transform. */
          _enc,
          /** Callback that receives the transformed chunk. */
          cb,
        ) {
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
