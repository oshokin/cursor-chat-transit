import { transferEvent, transferProgress, traceIO } from './transfer-events';
import { writeFile } from './trace-fs';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { FileBlobStore } from './blob-store';
import { BundleIndexWriter } from './bundle-index';
import {
  BUNDLE_FORMAT,
  EXPORT_FORMAT_VERSION,
  MAX_JSON_KEYS,
  MAX_MANIFEST_BYTES,
} from './bundle-limits';
import { ordinalName } from './bundle-names';
import { packZip } from './bundle-zip';
import { hashFile } from './hash-file';
import { NdjsonPartWriter } from './ndjson-io';
import { parseBoundedJson, type JsonEnvelope } from './record-json';

/** How the conversation array was stored beside the composer fields. */
export type ConversationLayout = 'absent' | 'empty' | 'ndjson';

/** One resource pointer stored beside a chat. Bytes live under `blobs/`. */
export interface BundleResourceRef {
  class: 'kv' | 'image' | 'plan' | 'canvas' | 'host-snapshot';
  /** KV key, image id, or file basename. */
  id: string;
  /** SHA-256 of the blob bytes. */
  sha256: string;
  byteLength: number;
  /** SQLite storage class for kv values. */
  storageClass?: 'text' | 'blob';
  /** Registry contract for renderer-owned KV records. */
  registryVersion?: 1;
  /** Registry family for renderer-owned KV records. */
  family?: import('./chat-kv-registry').ChatKvFamily;
  /** Image or plan basename written on import. */
  filename?: string;
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
  /** Disk-backed authoritative v5 inventory and catalog. */
  private readonly index: BundleIndexWriter;
  private readonly blobs: FileBlobStore;
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
    /** Directory that contains the extracted or staged archive. */
    root: string,
    index: BundleIndexWriter,
    /** Cancellation for packing. */
    private readonly signal: AbortSignal | undefined,
    /** Provenance stored on the manifest when present. */
    private readonly source: unknown,
    /** Property budget for one user payload in this archive. */
    private readonly maxJsonProperties?: number,
  ) {
    this.root = root;
    this.index = index;
    this.blobs = new FileBlobStore(path.join(root, 'blobs'));

    this.catalog = new NdjsonPartWriter(
      path.join(root, 'catalog'),
      signal,
      maxJsonProperties,
    );
  }

  /** Create a staging directory next to the destination archive. */
  static async open(
    destPath: string,
    opts?: {
      /** Cancellation for packing. */
      signal?: AbortSignal;
      /** Provenance stored on the manifest when present. */
      source?: unknown;
      /** Property budget for one user payload in this archive. */
      maxJsonProperties?: number;
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

    const index = await BundleIndexWriter.create(
      path.join(root, 'index.sqlite'),
      opts?.signal,
    );

    return new BundleWriter(
      destPath,
      root,
      index,
      opts?.signal,
      opts?.source,
      opts?.maxJsonProperties,
    );
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

    await writeJson(
      path.join(this.chatDir, 'header.json'),
      header,
      false,
      this.maxJsonProperties,
    );

    this.conversationLayout = 'absent';

    this.conversation = new NdjsonPartWriter(
      path.join(this.chatDir, 'conversation'),
      this.signal,
      this.maxJsonProperties,
    );

    this.bubbles = new NdjsonPartWriter(
      path.join(this.chatDir, 'bubbles'),
      this.signal,
      this.maxJsonProperties,
      'bubble',
    );

    this.resources = new NdjsonPartWriter(
      path.join(this.chatDir, 'resources'),
      this.signal,
      this.maxJsonProperties,
    );

    await this.catalog.write({
      ordinal: this.ordinal,
      sourceComposerId: id,
      name: typeof header.name === 'string' ? header.name : undefined,
    });

    await this.index.addChat({
      ordinal: this.ordinal,
      sourceComposerId: id,
      name: typeof header.name === 'string' ? header.name : undefined,
    });
  }

  /** Store composer fields and whether the conversation array existed. */
  async writeComposer(
    /** Composer fields without the conversation array. */
    fields: Record<string, unknown>,
    /** Whether the conversation array was present. */
    conversation: ConversationLayout,
  ): Promise<void> {
    this.conversationLayout = conversation;

    await writeJson(
      path.join(this.chatDir, 'composer.json'),
      {
        conversation,
        fields,
      },
      true,
      this.maxJsonProperties,
      'composer',
    );
  }

  /** Append one conversation element in source order. */
  async writeConversation(
    /** One conversation element, in source order. */
    value: unknown,
  ): Promise<void> {
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
  async writeResource(
    /** Resource pointer. */
    ref: BundleResourceRef,
  ): Promise<void> {
    await this.resources!.write(ref);
  }

  /** Copy blob bytes once. Later calls with the same hash reuse the file. */
  async addBlob(sha256: string, sourcePath: string): Promise<void> {
    await traceIO(
      'Copy blob into archive',
      { source: sourcePath, destination: this.blobs.path(sha256) },
      () => this.blobs.putFile(sha256, sourcePath, this.signal),
    );
  }

  /** Copy an opaque native host component into this chat directory. */
  async writeHostSnapshot(
    sessionId: string,
    database: string,
    meta: string,
  ): Promise<void> {
    if (sessionId !== path.basename(sessionId))
      throw new Error('Invalid host session id.');
    const root = path.join(this.chatDir, 'host-snapshot');

    await mkdir(root, { recursive: false, mode: 0o700 });

    await pipeline(
      createReadStream(database),
      createWriteStream(path.join(root, 'session.sqlite'), {
        flags: 'wx',
        mode: 0o600,
      }),
      { signal: this.signal },
    );

    await pipeline(
      createReadStream(meta),
      createWriteStream(path.join(root, 'meta.json'), {
        flags: 'wx',
        mode: 0o600,
      }),
      { signal: this.signal },
    );

    await writeJson(path.join(root, 'component.json'), {
      class: 'host-snapshot',
      version: 1,
      sessionId,
    });
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
  async finish(
    /** Manifest fields written with the archive. */
    summary?: unknown,
  ): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.catalog.finish();
    const { rm } = await import('node:fs/promises');
    let contentBytes = 0;
    let fileCount = 0;

    for await (const file of listFiles(this.root)) {
      this.signal?.throwIfAborted();
      const hashed = await hashFile(file.diskPath, this.signal);

      fileCount += 1;
      contentBytes += hashed.bytes;

      await this.index.addInventory({
        path: file.name,
        bytes: hashed.bytes,
        sha256: hashed.sha256,
        kind: kindOf(file.name),
      });
    }

    await this.index.finish();

    transferProgress('pack', { file: this.destPath });
    const indexPath = path.join(this.root, 'index.sqlite');
    const indexHash = await hashFile(indexPath, this.signal);

    const manifest = {
      format: BUNDLE_FORMAT,
      formatVersion: EXPORT_FORMAT_VERSION,
      producer: 'cursor-chat-transit',
      createdAt: new Date().toISOString(),
      source: this.source ?? undefined,
      capabilities: {
        required: ['sqlite-index-v1', 'content-addressed-blobs-v1'],
        optional: [],
      },
      index: {
        path: 'index.sqlite',
        bytes: indexHash.bytes,
        sha256: indexHash.sha256,
      },
      counts: {
        chats: this.ordinal,
        files: fileCount,
        contentBytes,
      },
      ...(summary === undefined ? {} : { summary }),
    };

    const manifestPath = path.join(this.root, 'manifest.json');

    await writeJson(manifestPath, manifest, false, MAX_JSON_KEYS);
    const manifestStat = await hashFile(manifestPath, this.signal);

    if (manifestStat.bytes > MAX_MANIFEST_BYTES) {
      throw new Error('Export manifest exceeds 1 MiB.');
    }

    const packed = async function* (
      root: string,
    ): AsyncGenerator<{ diskPath: string; name: string }> {
      yield { diskPath: manifestPath, name: 'manifest.json' };
      yield { diskPath: indexPath, name: 'index.sqlite' };
      yield* listFiles(root);
    };

    try {
      await packZip(this.destPath, packed(this.root), this.signal);
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

    await this.index.finish().catch(() => undefined);

    await rm(this.root, { recursive: true, force: true });
  }
}

/** Write bounded JSON; only private staged composer metadata may be replaced. */
async function writeJson(
  filePath: string,
  /** JSON value to write. */
  value: unknown,
  /** Replace an existing staged file. */
  overwrite = false,
  /** Property budget for this record. Manifest uses the fixed schema budget. */
  maxProperties?: number,
  /** Unwrap a known archive record before counting properties. */
  envelope?: JsonEnvelope,
): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(value), 'utf8');

  parseBoundedJson(bytes, path.basename(filePath), maxProperties, envelope);

  await writeFile(filePath, bytes, {
    flag: overwrite ? 'w' : 'wx',
    mode: 0o600,
  });
}

/** Relative paths of bundle files, except the manifest and inventory. */
async function* listFiles(
  /** Directory that contains the extracted or staged archive. */
  root: string,
): AsyncGenerator<{
  /** Absolute path of the file. */
  diskPath: string;
  /** Path of that file inside the archive. */
  name: string;
}> {
  const { readdir } = await import('node:fs/promises');
  const directories = [root];

  while (directories.length) {
    const dir = directories.pop()!;
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries.sort((a, b) => (a.name < b.name ? 1 : -1))) {
      const diskPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        directories.push(diskPath);
        continue;
      }

      if (!entry.isFile()) continue;
      const name = path.relative(root, diskPath).split(path.sep).join('/');

      if (name === 'manifest.json' || name === 'index.sqlite') continue;
      yield { diskPath, name };
    }
  }
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

/** Streaming chat sink shared by archive writing and read-only health inspection. */
export type ExportChatWriter = Pick<
  BundleWriter,
  | 'beginChat'
  | 'writeComposer'
  | 'writeConversation'
  | 'writeBubble'
  | 'writeResource'
  | 'addBlob'
  | 'writeHostSnapshot'
  | 'endChat'
>;
