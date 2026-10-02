import { mapInBatches } from './bounded-io';
import { transferEvent, transferProgress, traceIO } from './transfer-events';
import { writeFile } from './trace-fs';
import { createReadStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import {
  BUNDLE_FORMAT,
  EXPORT_FORMAT_VERSION,
  MAX_MANIFEST_BYTES,
} from './bundle-limits';
import { ordinalName } from './bundle-names';
import { packZip } from './bundle-zip';
import { hashFile } from './hash-file';
import { NdjsonPartWriter, writeNdjsonLine } from './ndjson-io';
import { parseBoundedJson } from './record-json';

/** How the conversation array was stored beside the composer fields. */
export type ConversationLayout = 'absent' | 'empty' | 'ndjson';

/** One resource pointer stored beside a chat. Bytes live under `blobs/`. */
export interface BundleResourceRef {
  /** Resource class. */
  class: 'kv' | 'image' | 'plan' | 'canvas';
  /** KV key, image id, or file basename. */
  id: string;
  /** SHA-256 of the blob bytes. */
  sha256: string;
  /** Decoded byte length. */
  byteLength: number;
  /** SQLite storage class for kv values. */
  storageClass?: 'text' | 'blob';
  /** Image or plan basename written on import. */
  filename?: string;
  /** Image extension. */
  extension?: string;
  /** Other basenames with these same bytes. */
  aliases?: string[];
}

/** Streaming writer for one v4 archive. */
export class BundleWriter {
  /** Staging directory that is packed into the archive. */
  private readonly root: string;
  /** NDJSON catalog of chats written into this archive. */
  private readonly catalog: NdjsonPartWriter;
  /** Number of chats begun so far. */
  private ordinal = 0;
  /** Directory of the chat currently being written. */
  private chatDir = '';
  /** Conversation rows for the current chat. */
  private conversation: NdjsonPartWriter | undefined;
  /** Bubbles for the current chat. */
  private bubbles: NdjsonPartWriter | undefined;
  /** Resource pointers for the current chat. */
  private resources: NdjsonPartWriter | undefined;
  /** How the current conversation array is stored. */
  private conversationLayout: ConversationLayout = 'absent';
  /** True after the archive has been packed. */
  private closed = false;

  /** Stage one archive beside `destPath`. Use `open`. */
  private constructor(
    /** Final archive path. Staging is created beside it. */
    private readonly destPath: string,
    root: string,
    /** Cancellation for packing. */
    private readonly signal: AbortSignal | undefined,
    /** Provenance stored on the manifest when present. */
    private readonly source: unknown,
  ) {
    this.root = root;
    this.catalog = new NdjsonPartWriter(path.join(root, 'catalog'), signal);
  }

  /** Create a staging directory next to the destination archive. */
  static async open(
    destPath: string,
    opts?: {
      /** Cancellation for packing. */
      signal?: AbortSignal;
      /** Provenance stored on the manifest when present. */
      source?: unknown;
    },
  ): Promise<BundleWriter> {
    const { mkdtemp } = await import('node:fs/promises');
    const root = await mkdtemp(`${destPath}.staging-`);

    transferEvent({
      action: 'Create export staging directory',
      status: 'completed',
      path: root,
    });

    await mkdir(path.join(root, 'catalog'), { recursive: true });
    await mkdir(path.join(root, 'blobs'), { recursive: true });

    return new BundleWriter(destPath, root, opts?.signal, opts?.source);
  }

  /** Begin one chat. `header.composerId` is required and is not used as a path. */
  async beginChat(header: Record<string, unknown>): Promise<void> {
    this.signal?.throwIfAborted();
    const id = header.composerId;

    if (typeof id !== 'string' || !id) {
      throw new Error('Chat header is missing composerId.');
    }

    this.ordinal += 1;
    this.chatDir = path.join(this.root, 'chats', ordinalName(this.ordinal));
    await mkdir(this.chatDir, { recursive: true });
    await writeJson(path.join(this.chatDir, 'header.json'), header);
    this.conversationLayout = 'absent';

    this.conversation = new NdjsonPartWriter(
      path.join(this.chatDir, 'conversation'),
      this.signal,
    );

    this.bubbles = new NdjsonPartWriter(
      path.join(this.chatDir, 'bubbles'),
      this.signal,
    );

    this.resources = new NdjsonPartWriter(
      path.join(this.chatDir, 'resources'),
      this.signal,
    );

    await this.catalog.write({
      ordinal: this.ordinal,
      sourceComposerId: id,
      name: typeof header.name === 'string' ? header.name : undefined,
    });
  }

  /** Store composer fields and whether the conversation array existed. */
  async writeComposer(
    fields: Record<string, unknown>,
    conversation: ConversationLayout,
  ): Promise<void> {
    this.conversationLayout = conversation;

    await writeJson(path.join(this.chatDir, 'composer.json'), {
      conversation,
      fields,
    });
  }

  /** Append one conversation element in source order. */
  async writeConversation(value: unknown): Promise<void> {
    if (this.conversationLayout !== 'ndjson') {
      throw new Error('Conversation item written for an empty conversation.');
    }

    await this.conversation!.write(value);
  }

  /** Append one bubble payload. */
  async writeBubble(bubbleId: string, payload: unknown): Promise<void> {
    if (!bubbleId) throw new Error('Bubble id is missing.');
    await this.bubbles!.write({ bubbleId, payload });
  }

  /** Append one resource pointer. */
  async writeResource(ref: BundleResourceRef): Promise<void> {
    await this.resources!.write(ref);
  }

  /** Copy blob bytes once. Later calls with the same hash reuse the file. */
  async addBlob(sha256: string, sourcePath: string): Promise<void> {
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('Invalid blob hash.');
    const dest = blobPath(this.root, sha256);

    try {
      await mkdir(path.dirname(dest), { recursive: true });

      await traceIO(
        'Copy blob into archive',
        { source: sourcePath, destination: dest },
        () =>
          pipeline(
            createReadStream(sourcePath),
            createWriteStream(dest, { flags: 'wx', mode: 0o600 }),
            { signal: this.signal },
          ),
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }

  /** Finish the open chat's part files. */
  async endChat(): Promise<void> {
    await this.conversation?.finish();
    await this.bubbles?.finish();
    await this.resources?.finish();
    this.conversation = undefined;
    this.bubbles = undefined;
    this.resources = undefined;
  }

  /** Write inventory and manifest, pack the ZIP, and delete staging. */
  async finish(summary?: unknown): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.catalog.finish();
    const files = await listFiles(this.root);
    const inventoryPath = path.join(this.root, 'inventory.ndjson');
    const { open, rm } = await import('node:fs/promises');
    const inventory = await open(inventoryPath, 'wx');
    let contentBytes = 0;

    try {
      for await (const batch of mapInBatches(
        files,
        async (file) => ({
          file,
          hashed: await hashFile(file.diskPath, this.signal),
        }),
        this.signal,
      )) {
        for (const { file, hashed } of batch) {
          contentBytes += hashed.bytes;

          await writeNdjsonLine(inventory, {
            path: file.name,
            bytes: hashed.bytes,
            sha256: hashed.sha256,
            kind: kindOf(file.name),
          });
        }
      }

      await inventory.sync();
    } finally {
      await inventory.close();
    }

    transferProgress('pack', { file: this.destPath });
    const inventoryHash = await hashFile(inventoryPath, this.signal);

    const manifest = {
      format: BUNDLE_FORMAT,
      formatVersion: EXPORT_FORMAT_VERSION,
      producer: 'cursor-chat-transit',
      createdAt: new Date().toISOString(),
      source: this.source ?? undefined,
      inventory: {
        path: 'inventory.ndjson',
        bytes: inventoryHash.bytes,
        sha256: inventoryHash.sha256,
      },
      counts: {
        chats: this.ordinal,
        files: files.length,
        contentBytes,
      },
      ...(summary === undefined ? {} : { summary }),
    };

    const manifestPath = path.join(this.root, 'manifest.json');

    await writeJson(manifestPath, manifest);
    const manifestStat = await hashFile(manifestPath, this.signal);

    if (manifestStat.bytes > MAX_MANIFEST_BYTES) {
      throw new Error('Export manifest exceeds 1 MiB.');
    }

    const packed = [
      { diskPath: manifestPath, name: 'manifest.json' },
      { diskPath: inventoryPath, name: 'inventory.ndjson' },
      ...files,
    ];

    try {
      await packZip(this.destPath, packed, this.signal);
    } finally {
      await rm(this.root, { recursive: true, force: true });
    }
  }

  /** Delete a partial staging directory. The destination archive is left unchanged. */
  async abort(): Promise<void> {
    this.closed = true;
    const { rm } = await import('node:fs/promises');

    await Promise.allSettled([
      this.catalog.finish(),
      this.conversation?.finish(),
      this.bubbles?.finish(),
      this.resources?.finish(),
    ]);

    await rm(this.root, { recursive: true, force: true });
  }
}

/** Content-addressed path `blobs/xx/<sha256>.bin`. */
function blobPath(root: string, sha256: string): string {
  return path.join(root, 'blobs', sha256.slice(0, 2), `${sha256}.bin`);
}

/** Write a JSON file that must not already exist. */
async function writeJson(filePath: string, value: unknown): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(value), 'utf8');

  parseBoundedJson(bytes, path.basename(filePath));
  await writeFile(filePath, bytes, { flag: 'wx', mode: 0o600 });
}

/** Relative paths of bundle files, except the manifest and inventory. */
async function listFiles(
  root: string,
): Promise<Array<{ diskPath: string; name: string }>> {
  const { readdir } = await import('node:fs/promises');
  const out: Array<{ diskPath: string; name: string }> = [];

  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const diskPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        await walk(diskPath);
        continue;
      }

      const name = path.relative(root, diskPath).split(path.sep).join('/');

      if (name === 'manifest.json' || name === 'inventory.ndjson') continue;
      out.push({ diskPath, name });
    }
  };

  await walk(root);

  return out;
}

/** Inventory kind for one bundle-relative path. */
function kindOf(name: string): string {
  if (name.startsWith('catalog/')) return 'catalog';
  if (name.endsWith('/header.json')) return 'header';
  if (name.endsWith('/composer.json')) return 'composer';
  if (name.includes('/conversation/')) return 'conversation';
  if (name.includes('/bubbles/')) return 'bubbles';
  if (name.includes('/resources/')) return 'resources';
  if (name.startsWith('blobs/')) return 'blob';

  return 'file';
}
