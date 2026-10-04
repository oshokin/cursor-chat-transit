import fs from 'node:fs';
import path from 'node:path';
import { EXPORT_FORMAT_VERSION as BUNDLE_VERSION } from './bundle-limits';
import { readBundleObject } from './bundle-object';
import type { FileHandle } from 'node:fs/promises';
import type {
  BubbleRecord,
  ComposerHeader,
  ExportObject,
  ExportResources,
} from './types';

/** UTF-8 write size so large exports never become one giant Buffer. */
const WRITE_CHUNK = 64 * 1024;

/** Current on-disk export format. Legacy 2 remains readable. */
export const EXPORT_FORMAT_VERSION = 3;
/** Format 2 envelopes remain readable; new writes use format 3. */
export const LEGACY_EXPORT_FORMAT_VERSION = 2;

/** Validate export JSON shape; duplicate composer ids are errors. */
export function assertExportShape(obj: unknown): ExportObject {
  if (!obj || typeof obj !== 'object')
    throw new Error('Invalid export file format.');
  const rec = obj as Record<string, unknown>;

  if (
    rec.formatVersion !== undefined &&
    rec.formatVersion !== EXPORT_FORMAT_VERSION &&
    rec.formatVersion !== LEGACY_EXPORT_FORMAT_VERSION &&
    rec.formatVersion !== BUNDLE_VERSION
  ) {
    throw new Error(`Unsupported export formatVersion: ${rec.formatVersion}`);
  }

  if (!Array.isArray(rec.allComposers))
    throw new Error('Invalid export: allComposers must be an array.');

  if (
    rec.composers === null ||
    typeof rec.composers !== 'object' ||
    Array.isArray(rec.composers)
  ) {
    throw new Error('Invalid export: composers must be an object.');
  }

  if (
    rec.bubbles !== null &&
    rec.bubbles !== undefined &&
    (typeof rec.bubbles !== 'object' || Array.isArray(rec.bubbles))
  ) {
    throw new Error('Invalid export: bubbles must be an object.');
  }

  if (
    rec.resources !== undefined &&
    (rec.resources === null ||
      typeof rec.resources !== 'object' ||
      Array.isArray(rec.resources))
  ) {
    throw new Error('Invalid export: resources must be an object.');
  }

  const ids = new Set<string>();

  for (const c of rec.allComposers) {
    if (
      !c ||
      typeof c !== 'object' ||
      typeof (
        c as {
          /** Composer id when the value has one. */
          composerId?: unknown;
        }
      ).composerId !== 'string' ||
      !(
        c as {
          composerId: string;
        }
      ).composerId
    ) {
      throw new Error('Invalid export: composer metadata missing composerId.');
    }

    const composerId = (
      c as {
        composerId: string;
      }
    ).composerId;

    if (ids.has(composerId))
      throw new Error(`Invalid export: duplicate composerId ${composerId}`);
    ids.add(composerId);
  }

  return rec as unknown as ExportObject;
}

/** Composer ids in `allComposers` that have no `composers[id]` body. */
export function incompleteComposers(obj: ExportObject): string[] {
  const missing: string[] = [];

  for (const c of obj.allComposers || []) {
    const id = c && c.composerId;

    if (!id) continue;
    if (obj.composers[id] === undefined || obj.composers[id] === null)
      missing.push(id);
  }

  return missing;
}

/** Write JSON via a unique temp file, fsync, then rename. */
export async function writeJsonAtomic(
  destPath: string,
  /** JSON value written atomically. */
  value: unknown,
): Promise<void> {
  const dir = path.dirname(destPath);

  const tmp = path.join(
    dir,
    `${path.basename(destPath)}.${process.pid}.${Date.now()}.partial`,
  );

  const json = JSON.stringify(value, null, 2);

  await fs.promises.writeFile(tmp, json, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });

  const fh = await fs.promises.open(tmp, 'r+');

  try {
    await fh.sync();
  } finally {
    await fh.close();
  }

  await fs.promises.rename(tmp, destPath);
}

/** Write UTF-8 in bounded chunks; every call waits for the bytes to be accepted. */
async function writeChunk(
  file: FileHandle,
  /** Text to parse or log. */
  text: string,
  signal?: AbortSignal,
): Promise<void> {
  const bytes = Buffer.from(text, 'utf8');
  let offset = 0;

  while (offset < bytes.length) {
    signal?.throwIfAborted();
    const size = Math.min(WRITE_CHUNK, bytes.length - offset);
    const result = await file.write(bytes, offset, size, null);

    if (result.bytesWritten === 0)
      throw new Error('File write made no progress');
    offset += result.bytesWritten;
  }
}

/** Stream an export file so JSON.stringify never sees the whole payload. */
export class ExportFileWriter {
  /** True until the first composer object has been written. */
  private composerFirst = true;
  /** True until the first bubble group object has been written. */
  private bubbleGroupFirst = true;
  /** True until the first bubble in the current group has been written. */
  private bubbleFirst = true;
  /** True after `finalize` or a failed close; further writes are rejected. */
  private closed = false;

  /** Bind the destination, sibling temp file, and open handle. */
  private constructor(
    /** Final path of the export file. */
    private readonly destPath: string,
    /** Sibling temporary file written until finalize. */
    private readonly tmpPath: string,
    /** Open handle for `tmpPath`. */
    private readonly file: FileHandle,
    /** Cancellation for further writes. */
    private readonly signal?: AbortSignal,
  ) {}

  /** Create a temp file next to the destination. */
  static async open(
    destPath: string,
    signal?: AbortSignal,
  ): Promise<ExportFileWriter> {
    signal?.throwIfAborted();
    const dir = path.dirname(destPath);

    const tmpPath = path.join(
      dir,
      `${path.basename(destPath)}.${process.pid}.${Date.now()}.partial`,
    );

    const file = await fs.promises.open(tmpPath, 'wx', 0o600);

    return new ExportFileWriter(destPath, tmpPath, file, signal);
  }

  /** Write UTF-8 and wait for the handle to accept every byte. */
  private async write(chunk: string): Promise<void> {
    if (this.closed) throw new Error('Export writer is closed');
    await writeChunk(this.file, chunk, this.signal);
  }

  /** Write formatVersion, source, allComposers, and open the composers object. */
  async writePreamble(opts: {
    /** Envelope version written at the start of the file. */
    formatVersion: number;
    /** Provenance object recorded beside the chats. */
    source: unknown;
    /** Selected composer headers written before composer bodies. */
    allComposers: ComposerHeader[];
  }): Promise<void> {
    await this.write('{\n  "formatVersion": ');
    await this.write(JSON.stringify(opts.formatVersion));
    await this.write(',\n  "source": ');

    await this.write(
      JSON.stringify(opts.source, null, 2).replace(/\n/g, '\n  '),
    );

    await this.write(',\n  "allComposers": ');

    await this.write(
      JSON.stringify(opts.allComposers, null, 2).replace(/\n/g, '\n  '),
    );

    await this.write(',\n  "composers": {');
  }

  /** Append one composer body. */
  async writeComposer(id: string, body: string): Promise<void> {
    await this.write(this.composerFirst ? '\n' : ',\n');
    this.composerFirst = false;
    await this.write(`    ${JSON.stringify(id)}: ${JSON.stringify(body)}`);
  }

  /** Close composers and open bubbles. */
  async beginBubbles(): Promise<void> {
    await this.write('\n  },\n  "bubbles": {');
  }

  /** Append one composer's bubbles without stringifying the whole array at once. */
  async writeBubbleGroup(
    id: string,
    /** Bubble records to scan. */
    list: BubbleRecord[],
  ): Promise<void> {
    await this.beginBubbleGroup(id);
    for (const bubble of list) await this.writeBubble(bubble);
    await this.endBubbleGroup();
  }

  /** Open one composer bubble array. */
  async beginBubbleGroup(id: string): Promise<void> {
    await this.write(this.bubbleGroupFirst ? '\n' : ',\n');
    this.bubbleGroupFirst = false;
    this.bubbleFirst = true;
    await this.write(`    ${JSON.stringify(id)}: [`);
  }

  /** Append one bubble record. */
  async writeBubble(bubble: BubbleRecord): Promise<void> {
    await this.write(this.bubbleFirst ? '' : ',');
    this.bubbleFirst = false;
    await this.write(JSON.stringify(bubble));
  }

  /** Close the current composer bubble array. */
  async endBubbleGroup(): Promise<void> {
    await this.write(']');
  }

  /** Close bubbles, write resources and summary, fsync, and rename into place. */
  async finish(
    /** Manifest summary written beside the archive. */
    summary: NonNullable<ExportObject['summary']>,
    /** Resource rows for this chat. */
    resources?: ExportResources,
  ): Promise<void> {
    await this.write('\n  }');

    if (resources) {
      await this.write(',\n  "resources": {\n    "kv": [');

      for (let i = 0; i < resources.kv.length; i++) {
        await this.write(i === 0 ? '\n      ' : ',\n      ');
        await this.write(JSON.stringify(resources.kv[i]));
      }

      await this.write('\n    ],\n    "attachments": [');

      for (let i = 0; i < resources.attachments.length; i++) {
        await this.write(i === 0 ? '\n      ' : ',\n      ');
        await this.write(JSON.stringify(resources.attachments[i]));
      }

      await this.write('\n    ],\n    "plans": [');
      const plans = resources.plans || [];

      for (let i = 0; i < plans.length; i++) {
        await this.write(i === 0 ? '\n      ' : ',\n      ');
        await this.write(JSON.stringify(plans[i]));
      }

      await this.write('\n    ],\n    "canvases": [');
      const canvases = resources.canvases || [];

      for (let i = 0; i < canvases.length; i++) {
        await this.write(i === 0 ? '\n      ' : ',\n      ');
        await this.write(JSON.stringify(canvases[i]));
      }

      await this.write('\n    ]\n  }');
    }

    await this.write(',\n  "summary": ');
    await this.write(JSON.stringify(summary, null, 2).replace(/\n/g, '\n  '));
    await this.write('\n}\n');
    this.signal?.throwIfAborted();
    await this.file.sync();
    await this.file.close();
    this.closed = true;
    this.signal?.throwIfAborted();
    await fs.promises.rename(this.tmpPath, this.destPath);
  }

  /** Drop a partial export file after a failed write. */
  async abort(): Promise<void> {
    if (!this.closed) {
      this.closed = true;

      try {
        await this.file.close();
      } catch {
        /* already closed */
      }
    }

    try {
      await fs.promises.unlink(this.tmpPath);
    } catch {
      /* ignore */
    }
  }
}

/** Read a v4 archive into the small in-memory shape used by focused tests. */
export async function readJsonFile(
  filePath: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const handle = await fs.promises.open(filePath, 'r');

  try {
    const magic = Buffer.alloc(2);

    await handle.read(magic, 0, 2, 0);

    if (magic.toString('utf8') !== 'PK') {
      throw new Error(
        'This file is not a Cursor Chat Transit export. Export the chats again with the current extension. Older JSON exports are not imported.',
      );
    }
  } finally {
    await handle.close();
  }

  return readBundleObject(filePath, signal);
}
