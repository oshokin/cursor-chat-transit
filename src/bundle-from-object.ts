import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { decodeAttachment } from './attachments';
import { isBlobKey } from './chat-dependencies';
import { BundleWriter } from './bundle-writer';
import { decodeCanvas } from './canvases';
import { decodeSqliteBytes } from './dependencies';
import { decodePlan } from './plans';
import { assertExportShape } from './format';
import { splitConversation } from './import-policy';
import { parseBoundedJson } from './record-json';
import type { ExportObject } from './types';

/**
 * Spill an in-memory fixture into a v4 archive.
 * This is not a reader for old export files.
 */
export async function writeObjectBundle(
  destPath: string,
  obj: unknown,
): Promise<void> {
  const exportObj = assertExportShape(obj);

  const writer = await BundleWriter.open(destPath, {
    source: exportObj.source,
  });

  const tmp = await mkdtemp(path.join(os.tmpdir(), 'cct-fixture-'));

  try {
    for (const header of exportObj.allComposers) {
      const body = exportObj.composers[header.composerId];

      if (typeof body !== 'string') continue;

      const parsed = parseBoundedJson(
        Buffer.from(body, 'utf8'),
        `composer ${header.composerId}`,
      );

      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`Composer ${header.composerId} is not an object.`);
      }

      const split = splitConversation(parsed as Record<string, unknown>);
      const layout = split.state === 'present' ? 'ndjson' : split.state;

      await writer.beginChat(header as Record<string, unknown>);
      await writer.writeComposer(split.fields, layout);

      for (const item of split.items) await writer.writeConversation(item);

      for (const bubble of exportObj.bubbles?.[header.composerId] || []) {
        const payload = parseBoundedJson(
          Buffer.from(bubble.value, 'utf8'),
          `bubble ${bubble.bubbleId}`,
        );

        await writer.writeBubble(bubble.bubbleId, payload);
      }

      await writeFixtureResources(writer, tmp, exportObj);
      await writer.endChat();
    }

    await writer.finish();
  } catch (err) {
    await writer.abort();

    throw err;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** Copy v3 resource rows into the v4 writer. */
async function writeFixtureResources(
  writer: BundleWriter,
  tmp: string,
  exportObj: ExportObject,
): Promise<void> {
  const resources = exportObj.resources;

  if (!resources) return;

  for (const row of resources.kv || []) {
    if (!isBlobKey(row.key)) {
      throw new Error('Export contains a resource key that is not allowed.');
    }

    const bytes = decodeSqliteBytes(row.value);
    const file = await spill(tmp, row.value.sha256, bytes);

    await writer.addBlob(row.value.sha256, file);

    await writer.writeResource({
      class: 'kv',
      id: row.key,
      sha256: row.value.sha256,
      byteLength: row.value.byteLength,
      storageClass: row.value.storageClass,
    });
  }

  for (const row of resources.attachments || []) {
    const bytes = decodeAttachment(row);
    const file = await spill(tmp, row.sha256, bytes);

    await writer.addBlob(row.sha256, file);

    await writer.writeResource({
      class: 'image',
      id: row.id,
      sha256: row.sha256,
      byteLength: row.byteLength,
      filename: row.filename,
      extension: row.extension,
      aliases: row.aliases,
    });
  }

  for (const row of resources.plans || []) {
    const bytes = decodePlan(row);
    const file = await spill(tmp, row.sha256, bytes);

    await writer.addBlob(row.sha256, file);

    await writer.writeResource({
      class: 'plan',
      id: row.filename,
      filename: row.filename,
      sha256: row.sha256,
      byteLength: row.byteLength,
    });
  }

  for (const row of resources.canvases || []) {
    const bytes = decodeCanvas(row);
    const file = await spill(tmp, row.sha256, bytes);

    await writer.addBlob(row.sha256, file);

    await writer.writeResource({
      class: 'canvas',
      id: row.filename,
      filename: row.filename,
      sha256: row.sha256,
      byteLength: row.byteLength,
    });
  }
}

/** Write bytes once under their sha256 name. */
async function spill(dir: string, sha: string, bytes: Buffer): Promise<string> {
  const file = path.join(dir, sha);

  await writeFile(file, bytes, { flag: 'wx' }).catch(
    (err: NodeJS.ErrnoException) => {
      if (err.code !== 'EEXIST') throw err;
    },
  );

  return file;
}
