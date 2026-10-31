import { randomUUID } from 'node:crypto';
import { transferEvent, transferProgress, traceIO } from './transfer-events';
import {
  MAX_EXPANDED_ARCHIVE_BYTES,
  MAX_JSON_RECORD_BYTES,
  MAX_MANIFEST_BYTES,
  MAX_ZIP_COMPRESSION_RATIO,
} from './bundle-limits';
import { createHash } from 'node:crypto';
import { createWriteStream, createReadStream } from 'node:fs';
import { mkdir, rename, rm, statfs, stat } from 'node:fs/promises';
import path from 'node:path';
import { Transform, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type * as Yauzl from 'yauzl';
import { yauzl, yazl } from './zip-lib';
import { MAX_ZIP_ENTRIES } from './bundle-limits';
import { assertArchivePath } from './bundle-names';
import { TRANSFER_PROGRESS_THROTTLE_MS } from './progress-model';

/** Minimum interval between ZIP pack progress updates. */
export const ZIP_PACK_PROGRESS_INTERVAL_MS = 500;
/** Free space left untouched while extracting an archive. */
export const ZIP_EXTRACTION_DISK_RESERVE_BYTES = 64 * 1024 * 1024;

/** One ZIP member written to disk with its content hash. */
export interface ExtractedEntry {
  /** Archive-relative path using forward slashes. */
  name: string;
  /** Absolute path of the extracted file. */
  filePath: string;
  /** Uncompressed byte length. */
  bytes: number;
  sha256: string;
}

/** One source entry accepted by the streaming ZIP packer. */
export interface ZipSourceEntry {
  diskPath: string;
  name: string;
}

/** Pack files into `destPath` via a sibling partial, then rename. */
export async function packZip(
  destPath: string,
  /** Files to pack, in archive order. */
  files: Iterable<ZipSourceEntry> | AsyncIterable<ZipSourceEntry>,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  let totalBytes = 0;
  const partial = `${destPath}.${randomUUID()}.partial`;

  transferEvent({
    action: 'Pack ZIP',
    status: 'started',
    destination: partial,
  });

  transferProgress('pack', {
    scope: 'archive-packing',
    file: destPath,
    processed: 0,
    unit: 'bytes',
  });

  const zip = new yazl.ZipFile();
  const output = createWriteStream(partial, { flags: 'wx', mode: 0o600 });

  const done = pipeline(zip.outputStream, output, { signal });

  void done.catch(() => undefined);

  try {
    zip.on('error', (error) => (zip.outputStream as Readable).destroy(error));

    let written = 0,
      processed = 0,
      last = 0;

    zip.outputStream.on('data', (chunk: Buffer) => {
      written += chunk.length;

      if (Date.now() - last >= ZIP_PACK_PROGRESS_INTERVAL_MS) {
        last = Date.now();

        transferProgress('pack', {
          scope: 'archive-packing',
          file: destPath,
          bytes: written,
          processed,
          total: totalBytes,
          unit: 'bytes',
        });
      }
    });

    let entries = 0;

    for await (const file of files) {
      signal?.throwIfAborted();
      assertArchivePath(file.name);

      if (++entries > MAX_ZIP_ENTRIES) {
        throw new Error(`Archive exceeds ${MAX_ZIP_ENTRIES} entries.`);
      }

      const info = await traceIO(
        'Inspect ZIP source',
        { path: file.diskPath },
        () => stat(file.diskPath),
      );

      if (!info.isFile())
        throw new Error(`ZIP source is not a regular file: ${file.diskPath}`);
      const size = info.size;

      totalBytes += size;

      transferEvent({
        action: 'Queue file for ZIP',
        status: 'info',
        source: file.diskPath,
        destination: `${partial}!/${file.name}`,
      });

      // The generator opens only when yazl consumes this entry, not when it is queued.
      const source = Readable.from(
        (async function* () {
          transferEvent({
            action: 'Read file for ZIP',
            status: 'started',
            source: file.diskPath,
            destination: `${partial}!/${file.name}`,
          });

          const input = createReadStream(file.diskPath, { signal });

          try {
            for await (const chunk of input) {
              const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);

              processed += bytes.length;
              yield bytes;
            }

            transferEvent({
              action: 'Read file for ZIP',
              status: 'completed',
              path: file.diskPath,
              bytes: size,
            });
          } catch (error) {
            transferEvent({
              action: 'Read file for ZIP',
              status: 'failed',
              path: file.diskPath,
            });

            throw error;
          } finally {
            input.destroy();
          }
        })(),
        { objectMode: false },
      );

      source.on('error', (error) =>
        (zip.outputStream as Readable).destroy(error),
      );

      zip.addReadStream(source, file.name, {
        size,
        compress: true,
        mtime: new Date(0),
        mode: 0o644,
      });
    }

    zip.end();
    await done;

    transferProgress('pack', {
      scope: 'archive-packing',
      file: destPath,
      processed: totalBytes,
      total: totalBytes,
      unit: 'bytes',
      bytes: written,
    });
  } catch (err) {
    (zip.outputStream as Readable).destroy();
    output.destroy();
    await done.catch(() => undefined);

    transferEvent({
      action: 'Pack ZIP',
      status: 'failed',
      destination: partial,
    });

    await rm(partial, { force: true }).catch(() => undefined);

    throw err;
  }

  try {
    signal?.throwIfAborted();

    await traceIO(
      'Publish archive',
      { source: partial, destination: destPath },
      () => rename(partial, destPath),
    );
  } catch (error) {
    await rm(partial, { force: true }).catch(() => undefined);

    throw error;
  }
}

/** Read ZIP entries one at a time into `destDir`. The archive is not buffered. */
export async function extractZip(
  zipPath: string,
  /** Directory that receives extracted files. */
  destDir: string,
  signal?: AbortSignal,
): Promise<ExtractedEntry[]> {
  const entries: ExtractedEntry[] = [];

  await visitZip(
    zipPath,
    destDir,
    (entry) => {
      entries.push(entry);
    },
    signal,
  );

  return entries;
}

/** Extract sequentially and await the visitor before advancing to the next entry. */
export async function visitZip(
  zipPath: string,
  destDir: string,
  visitor: (entry: ExtractedEntry) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  // A metadata-only pass gives a stable byte denominator across small files.
  const metadata = await openZip(zipPath);
  let totalBytes = 0;
  let count = 0;

  try {
    for await (const entry of walkEntries(metadata, signal)) {
      if (++count > MAX_ZIP_ENTRIES)
        throw new Error(`Archive exceeds ${MAX_ZIP_ENTRIES} entries.`);
      assertArchivePath(entry.fileName);
      rejectSpecialEntry(entry);

      if (!entry.fileName.endsWith('/')) {
        if (
          entry.fileName === 'manifest.json' &&
          entry.uncompressedSize > MAX_MANIFEST_BYTES
        ) {
          throw new Error(
            `Archive entry exceeds its size or available disk budget: ${entry.fileName}`,
          );
        }

        rejectCompressionRatio(entry);
        totalBytes += entry.uncompressedSize;
      }

      if (!Number.isSafeInteger(totalBytes))
        throw new Error('Archive byte count exceeds the supported range.');
      if (totalBytes > MAX_EXPANDED_ARCHIVE_BYTES)
        throw new Error('Archive exceeds the aggregate expanded-size limit.');
    }
  } finally {
    metadata.close();
  }

  const zip = await openZip(zipPath);
  let processed = 0;
  let lastProgress = performance.now();

  /** Report progress for this step. */
  const report = (
    /** Archive path shown while extracting. */
    file = zipPath,
  ) =>
    transferProgress('extract', {
      file,
      scope: 'archive-extraction',
      processed,
      total: totalBytes,
      unit: 'bytes',
    });

  report();
  const seen = new Set<string>();
  const space = await statfs(destDir);

  let remaining = Math.max(
    0,
    space.bavail * space.bsize - ZIP_EXTRACTION_DISK_RESERVE_BYTES,
  );

  try {
    for await (const entry of walkEntries(zip, signal)) {
      signal?.throwIfAborted();
      const name = entry.fileName;

      assertArchivePath(name);
      rejectSpecialEntry(entry);
      const folded = name.normalize('NFC').toLocaleLowerCase('en-US');

      if (seen.has(folded)) {
        throw new Error(`Archive entry is duplicated: ${name}`);
      }

      seen.add(folded);

      if (seen.size > MAX_ZIP_ENTRIES) {
        throw new Error(`Archive exceeds ${MAX_ZIP_ENTRIES} entries.`);
      }

      if (name.endsWith('/')) continue;

      const limit =
        name === 'manifest.json'
          ? MAX_MANIFEST_BYTES
          : name.endsWith('.json') ||
              (name.endsWith('.ndjson') && name !== 'inventory.ndjson')
            ? MAX_JSON_RECORD_BYTES + 1
            : remaining;

      if (entry.uncompressedSize > limit || entry.uncompressedSize > remaining)
        throw new Error(
          `Archive entry exceeds its size or available disk budget: ${name}`,
        );
      remaining -= entry.uncompressedSize;
      const filePath = path.join(destDir, ...name.split('/'));

      await mkdir(path.dirname(filePath), { recursive: true });

      const hashed = await traceIO(
        'Extract ZIP entry',
        {
          source: `${zipPath}!/${name}`,
          destination: filePath,
          bytes: entry.uncompressedSize,
        },
        () =>
          writeEntry(zip, entry, filePath, signal, (bytes) => {
            processed += bytes;

            if (
              performance.now() - lastProgress >=
              TRANSFER_PROGRESS_THROTTLE_MS
            ) {
              lastProgress = performance.now();
              report(filePath);
            }
          }),
      );

      if (entry.uncompressedSize !== hashed.bytes) {
        throw new Error(
          `Archive entry ${name} declared ${entry.uncompressedSize} bytes but wrote ${hashed.bytes}.`,
        );
      }

      await visitor({
        name,
        filePath,
        bytes: hashed.bytes,
        sha256: hashed.sha256,
      });
    }
  } finally {
    zip.close();
  }

  report();
}

function rejectCompressionRatio(entry: Yauzl.Entry): void {
  if (
    entry.uncompressedSize > MAX_JSON_RECORD_BYTES &&
    (entry.compressedSize === 0 ||
      entry.uncompressedSize / entry.compressedSize > MAX_ZIP_COMPRESSION_RATIO)
  ) {
    throw new Error(
      `Archive entry has an unsafe compression ratio: ${entry.fileName}`,
    );
  }
}

/** Open a ZIP with strict names and validated sizes. */
function openZip(zipPath: string): Promise<Yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(
      zipPath,
      {
        lazyEntries: true,
        autoClose: false,
        strictFileNames: true,
        validateEntrySizes: true,
        decodeStrings: true,
      },
      (
        err,
        /** Open ZIP archive. */
        zip,
      ) => {
        if (err || !zip) {
          reject(
            new Error(
              'This file is not a Cursor Chat Transit export. Export the chats again with the current extension. Older JSON exports are not imported.',
            ),
          );

          return;
        }

        resolve(zip);
      },
    );
  });
}

/** Yield ZIP entries until the archive ends. */
async function* walkEntries(
  /** Open ZIP archive. */
  zip: Yauzl.ZipFile,
  signal?: AbortSignal,
): AsyncGenerator<Yauzl.Entry> {
  for (;;) {
    const entry = await new Promise<Yauzl.Entry | null>((resolve, reject) => {
      /** Resolve the next ZIP entry. */
      const onEntry = (
        /** Next ZIP entry. */
        next: Yauzl.Entry,
      ) => {
        cleanup();
        resolve(next);
      };

      /** Resolve when the archive has no further entries. */
      const onEnd = () => {
        cleanup();
        resolve(null);
      };

      /** Reject the walk when the archive reader fails. */
      const onError = (
        /** Failure from the archive reader. */
        err: Error,
      ) => {
        cleanup();
        reject(err);
      };

      /** Drop listeners after the walk settles. */
      const cleanup = () => {
        zip.removeListener('entry', onEntry);
        zip.removeListener('end', onEnd);
        zip.removeListener('error', onError);
      };

      zip.once('entry', onEntry);
      zip.once('end', onEnd);
      zip.once('error', onError);
      signal?.throwIfAborted();
      zip.readEntry();
    });

    if (!entry) return;
    yield entry;
  }
}

/** Reject encryption, symlinks, and unsupported ZIP versions. */
function rejectSpecialEntry(entry: Yauzl.Entry): void {
  if (entry.generalPurposeBitFlag & 0x1 || entry.generalPurposeBitFlag & 0x40) {
    throw new Error('Encrypted archive entries are not supported.');
  }

  const mode = (entry.externalFileAttributes >>> 16) & 0o170000;

  if (mode === 0o120000) {
    throw new Error('Symlink archive entries are not supported.');
  }

  if (entry.versionNeededToExtract > 45) {
    throw new Error('This archive uses an unsupported ZIP feature.');
  }
}

/** Stream one entry to disk and return its sha256 and byte count. */
function writeEntry(
  /** Open ZIP archive. */
  zip: Yauzl.ZipFile,
  entry: Yauzl.Entry,
  filePath: string,
  signal?: AbortSignal,
  /** Called with the number of bytes written. */
  onBytes?: (bytes: number) => void,
): Promise<{
  /** SHA-256 of the entry bytes. */
  sha256: string;
  /** Number of bytes written. */
  bytes: number;
}> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(
      entry,
      (
        err,
        /** Byte stream being consumed. */
        stream,
      ) => {
        if (err || !stream) {
          reject(err || new Error('Unable to read archive entry.'));

          return;
        }

        const hash = createHash('sha256');
        let bytes = 0;

        const tap = new Transform({
          /** Hash bytes without retaining the entry. */
          transform(
            chunk,
            /** Encoding ignored by this hash transform. */
            _enc,
            /** Callback that receives the transformed chunk. */
            cb,
          ) {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);

            bytes += buf.length;

            if (bytes > entry.uncompressedSize) {
              cb(new Error(`ZIP size mismatch: ${filePath}`));

              return;
            }

            onBytes?.(buf.length);

            hash.update(buf);
            cb(null, buf);
          },
        });

        pipeline(
          stream,
          tap,
          createWriteStream(filePath, { flags: 'wx', mode: 0o600 }),
          { signal },
        )
          .then(() => resolve({ sha256: hash.digest('hex'), bytes }))
          .catch(reject);
      },
    );
  });
}
