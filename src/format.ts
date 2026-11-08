import fs from 'node:fs';
import path from 'node:path';
import { EXPORT_FORMAT_VERSION } from './bundle-limits';

export { EXPORT_FORMAT_VERSION } from './bundle-limits';
import { readBundleObject } from './bundle-object';
import type { ExportObject } from './types';

/** Validate export JSON shape; duplicate composer ids are errors. */
export function assertExportShape(obj: unknown): ExportObject {
  if (!obj || typeof obj !== 'object')
    throw new Error('Invalid export file format.');
  const rec = obj as Record<string, unknown>;

  if (rec.formatVersion !== EXPORT_FORMAT_VERSION) {
    throw new Error(
      `Unsupported export formatVersion: ${rec.formatVersion}. Export the chats again with the current extension.`,
    );
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

/** Read a v5 archive into the small in-memory shape used by focused tests. */
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
