import * as fs from 'node:fs/promises';
import type { WriteFileOptions } from 'node:fs';
import { traceIO } from './transfer-events';

/** Read one file while identifying failures by its exact path. */
export function readFile(file: string): Promise<Buffer>;

/** Read one UTF-8 file while identifying failures by its exact path. */
export function readFile(file: string, encoding: 'utf8'): Promise<string>;

/** Read one file while identifying failures by its exact path. */
export function readFile(
  file: string,
  encoding?: 'utf8',
): Promise<Buffer | string> {
  return traceIO<Buffer | string>('Read file', { path: file }, () =>
    encoding ? fs.readFile(file, encoding) : fs.readFile(file),
  );
}

/** Write a bounded record; no payload is copied into logs. */
export function writeFile(
  file: string,
  data: string | Uint8Array,
  options?: WriteFileOptions,
): Promise<void> {
  return traceIO(
    'Write file',
    {
      path: file,
      bytes:
        typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength,
    },
    () => fs.writeFile(file, data, options),
  );
}
