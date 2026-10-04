import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { openBundle } from './bundle-reader';
import { ordinalName } from './bundle-names';
import type { BundleResourceRef } from './bundle-writer';
import { readNdjson } from './ndjson-io';
import { parseBoundedJson } from './record-json';
import type {
  BubbleRecord,
  ComposerHeader,
  ExportObject,
  ExportResources,
} from './types';

/** Rebuild a small archive into the in-memory shape used by focused tests. */
export async function readBundleObject(
  zipPath: string,
  signal?: AbortSignal,
): Promise<ExportObject> {
  const bundle = await openBundle(zipPath, signal);

  try {
    const allComposers: ComposerHeader[] = [];
    const composers: Record<string, string> = {};
    const bubbles: Record<string, BubbleRecord[]> = {};

    const resources: ExportResources = {
      kv: [],
      attachments: [],
      plans: [],
      canvases: [],
    };

    const seen = new Set<string>();

    for (const file of await ndjsonFiles(path.join(bundle.root, 'catalog'))) {
      for await (const row of readNdjson(file, 'catalog', signal)) {
        const rec = row.value as {
          /** Catalog ordinal of this chat. */
          ordinal?: number;
          sourceComposerId?: string;
        };

        const ordinal = rec.ordinal || 0;
        const dir = path.join(bundle.root, 'chats', ordinalName(ordinal));

        const header = parseBoundedJson(
          await readFile(path.join(dir, 'header.json')),
          'header',
        ) as ComposerHeader;

        allComposers.push(header);
        const id = header.composerId;

        const composer = parseBoundedJson(
          await readFile(path.join(dir, 'composer.json')),
          'composer',
          /** Whether the conversation array was present. */
        ) as {
          /** Recorded conversation layout, such as `empty` or `ndjson`. */
          conversation: string;
          /** Composer fields without the conversation array. */
          fields: Record<string, unknown>;
        };

        const fields = { ...composer.fields };

        if (composer.conversation === 'empty') {
          fields.fullConversationHeadersOnly = [];
        }

        if (composer.conversation === 'ndjson') {
          const items: unknown[] = [];

          for (const part of await ndjsonFiles(
            path.join(dir, 'conversation'),
          )) {
            for await (const item of readNdjson(part, 'conversation', signal)) {
              items.push(item.value);
            }
          }

          fields.fullConversationHeadersOnly = items;
        }

        composers[id] = JSON.stringify(fields);
        bubbles[id] = [];

        for (const part of await ndjsonFiles(path.join(dir, 'bubbles'))) {
          for await (const item of readNdjson(part, 'bubble', signal)) {
            const bubble = item.value as {
              bubbleId: string;
              /** Bubble body stored under that id. */
              payload: unknown;
            };

            bubbles[id].push({
              key: `bubbleId:${id}:${bubble.bubbleId}`,
              bubbleId: bubble.bubbleId,
              value: JSON.stringify(bubble.payload),
            });
          }
        }

        for (const part of await ndjsonFiles(path.join(dir, 'resources'))) {
          for await (const item of readNdjson(part, 'resource', signal)) {
            const ref = item.value as BundleResourceRef;
            const key = `${ref.class}\0${ref.sha256}\0${ref.id}`;

            if (seen.has(key)) continue;
            seen.add(key);

            const bytes = await readFile(
              path.join(
                bundle.root,
                'blobs',
                ref.sha256.slice(0, 2),
                `${ref.sha256}.bin`,
              ),
            );

            const base64 = bytes.toString('base64');

            if (ref.class === 'kv') {
              resources.kv.push({
                key: ref.id,
                value: {
                  storageClass: ref.storageClass || 'blob',
                  base64,
                  byteLength: ref.byteLength,
                  sha256: ref.sha256,
                },
              });
            } else if (ref.class === 'image') {
              resources.attachments.push({
                id: ref.id,
                base64,
                byteLength: ref.byteLength,
                sha256: ref.sha256,
                extension: ref.extension || 'bin',
                filename: ref.filename,
                aliases: ref.aliases,
              });
            } else if (ref.class === 'plan') {
              resources.plans.push({
                filename: ref.filename || ref.id,
                base64,
                byteLength: ref.byteLength,
                sha256: ref.sha256,
              });
            } else {
              resources.canvases!.push({
                filename: ref.filename || ref.id,
                base64,
                byteLength: ref.byteLength,
                sha256: ref.sha256,
              });
            }
          }
        }
      }
    }

    return {
      formatVersion: 4,
      allComposers,
      composers,
      bubbles,
      resources,
      summary: (bundle.manifest.summary as ExportObject['summary']) || {
        complete: true,
        incomplete: [],
        selected: allComposers.length,
        exported: allComposers.length,
      },
    };
  } finally {
    await bundle.close();
  }
}

/** Sorted `.ndjson` paths, or none when the directory is missing. */
async function ndjsonFiles(
  /** Directory to scan. */
  dir: string,
): Promise<string[]> {
  try {
    return (await readdir(dir))
      .filter((name) => name.endsWith('.ndjson'))
      .sort()
      .map((name) => path.join(dir, name));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];

    throw err;
  }
}
