import { transferEvent } from './transfer-events';
import { createReadStream } from 'node:fs';
import { mkdir, open, type FileHandle } from 'node:fs/promises';
import { partPath } from './bundle-names';
import { MAX_JSON_RECORD_BYTES, NDJSON_PART_BYTES } from './bundle-limits';
import { parseBoundedJson } from './record-json';

/** One decoded NDJSON value plus the UTF-8 size of its line. */
export interface NdjsonRecord {
  value: unknown;
  /** UTF-8 byte length of the line without the newline. */
  bytes: number;
}

/**
 * Read NDJSON without retaining a line that exceeds the record limit.
 * A file with no trailing newline is still one record when it fits.
 */
export async function* readNdjson(
  filePath: string,
  /** Name used when the value is rejected. */
  label: string,
  signal?: AbortSignal,
  /** Called with the number of bytes written. */
  onBytes?: (processed: number) => void,
): AsyncGenerator<NdjsonRecord> {
  transferEvent({ action: 'Read NDJSON', status: 'started', path: filePath });
  let readBytes = 0;

  const stream = createReadStream(filePath, {
    highWaterMark: 64 * 1024,
    signal,
  });

  let parts: Buffer[] = [];
  let pendingBytes = 0;

  /** Parse one complete line and drop the buffer that held it. */
  const emit = function* (
    /** One NDJSON line without its terminator. */
    line: Buffer,
  ): Generator<NdjsonRecord> {
    if (line.length && line[line.length - 1] === 0x0d) {
      line = line.subarray(0, line.length - 1);
    }

    if (!line.length) return;

    if (line.length > MAX_JSON_RECORD_BYTES) {
      throw new Error(
        `${label} is ${line.length} bytes; the limit is ${MAX_JSON_RECORD_BYTES}.`,
      );
    }

    yield { value: parseBoundedJson(line, label), bytes: line.length };
  };

  try {
    for await (const chunk of stream) {
      signal?.throwIfAborted();
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);

      readBytes += buf.length;

      let start = 0;

      while (start < buf.length) {
        const nl = buf.indexOf(0x0a, start);
        const end = nl < 0 ? buf.length : nl;
        const part = buf.subarray(start, end);

        pendingBytes += part.length;

        if (pendingBytes > MAX_JSON_RECORD_BYTES) {
          throw new Error(
            `${label} exceeds ${MAX_JSON_RECORD_BYTES} bytes; the limit is ${MAX_JSON_RECORD_BYTES}.`,
          );
        }

        if (part.length) parts.push(part);
        if (nl < 0) break;

        const line =
          parts.length === 1 ? parts[0] : Buffer.concat(parts, pendingBytes);

        parts = [];
        pendingBytes = 0;
        yield* emit(line);
        start = nl + 1;
      }

      onBytes?.(readBytes);
    }

    if (pendingBytes) yield* emit(Buffer.concat(parts, pendingBytes));

    transferEvent({
      action: 'Read NDJSON',
      status: 'completed',
      path: filePath,
      bytes: readBytes,
    });
  } catch (error) {
    transferEvent({
      action: 'Read NDJSON',
      status: 'failed',
      path: filePath,
      bytes: readBytes,
    });

    throw error;
  } finally {
    stream.destroy();
  }
}

/** Write one JSON line to an already opened file. */
export async function writeNdjsonLine(
  handle: FileHandle,
  /** JSON value written as one line. */
  value: unknown,
): Promise<number> {
  const line = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');

  if (line.length > MAX_JSON_RECORD_BYTES) {
    throw new Error(
      `JSON record is ${line.length} bytes; the limit is ${MAX_JSON_RECORD_BYTES}.`,
    );
  }

  await handle.writeFile(line);

  return line.length;
}

/** Append JSON lines and rotate when the current part reaches the part budget. */
export class NdjsonPartWriter {
  /** Open file for the current part. */
  private handle: FileHandle | undefined;
  /** Index of the current part. */
  private part = 0;
  /** Bytes written to the current part. */
  private size = 0;
  /** Part files written so far, in order. */
  private readonly paths: string[] = [];

  /** Open parts under `directory`. The next write stops when `signal` aborts. */
  constructor(
    /** Directory that receives rotated part files. */
    private readonly directory: string,
    /** Cancellation checked before each write. */
    private readonly signal?: AbortSignal,
  ) {}

  /** Files written so far, in order. */
  files(): readonly string[] {
    return this.paths;
  }

  /** Write one JSON value as a single line. The value must already be bounded. */
  async write(
    /** JSON value written as one NDJSON line. */
    value: unknown,
  ): Promise<void> {
    this.signal?.throwIfAborted();
    const line = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');

    if (line.length > MAX_JSON_RECORD_BYTES) {
      throw new Error(
        `JSON record is ${line.length} bytes; the limit is ${MAX_JSON_RECORD_BYTES}.`,
      );
    }

    if (this.size > 0 && this.size + line.length > NDJSON_PART_BYTES) {
      await this.rotate();
    }

    if (!this.handle) await this.rotate();
    await this.handle!.writeFile(line);
    this.size += line.length;

    if (this.size >= NDJSON_PART_BYTES) await this.closePart();
  }

  /** Close the current part. */
  async finish(): Promise<void> {
    await this.closePart();
  }

  /** Open the next NDJSON part. */
  private async rotate(): Promise<void> {
    await this.closePart();
    this.part += 1;
    await mkdir(this.directory, { recursive: true });
    const file = partPath(this.directory, this.part);

    transferEvent({ action: 'Write NDJSON', status: 'started', path: file });
    this.handle = await open(file, 'wx');
    this.paths.push(file);
    this.size = 0;
  }

  /** Fsync and close the current NDJSON part. */
  private async closePart(): Promise<void> {
    if (!this.handle) return;
    await this.handle.sync();
    await this.handle.close();

    transferEvent({
      action: 'Write NDJSON',
      status: 'completed',
      path: this.paths[this.paths.length - 1],
      bytes: this.size,
    });

    this.handle = undefined;
    this.size = 0;
  }
}
