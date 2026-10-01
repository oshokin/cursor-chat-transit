import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decodeCanonicalBase64,
  resourceError as fail,
  MAX_RESOURCE_BYTES,
  sha256Hex,
} from './resource-bytes';
import { pathInside, staysInRoot, writeFileNoClobber } from './resource-files';
import type { AttachmentResource, BubbleRecord, WorkspaceEntry } from './types';

/** Canonical UUID form used in bubble `images[].uuid`. */
export const IMAGE_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Image suffixes Cursor stores next to the workspace database. */
export const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']);

/** Envelope for an attached image. */
export function encodeAttachment(
  id: string,
  bytes: Buffer,
  extension: string,
  filename?: string,
): AttachmentResource {
  if (!IMAGE_UUID.test(id)) fail('INVALID_RESOURCE', 'Invalid attachment id.');
  const ext = extension.toLowerCase();

  if (!IMAGE_EXT.has(ext)) {
    fail('INVALID_RESOURCE', 'Unsupported attachment type.');
  }

  if (bytes.length > MAX_RESOURCE_BYTES) {
    fail('INVALID_RESOURCE', 'Attachment exceeds size limit.');
  }

  if (filename !== undefined && !attachmentNameRank(filename, id)) {
    fail('INVALID_RESOURCE', 'Invalid attachment filename.');
  }

  return {
    id,
    base64: bytes.toString('base64'),
    byteLength: bytes.length,
    sha256: sha256Hex(bytes),
    extension: ext,
    ...(filename ? { filename } : {}),
  };
}

/** Validate and decode an attachment envelope. */
export function decodeAttachment(value: AttachmentResource): Buffer {
  if (!IMAGE_UUID.test(value.id)) {
    fail('INVALID_RESOURCE', 'Invalid attachment id.');
  }

  const ext = String(value.extension || '').toLowerCase();

  if (!IMAGE_EXT.has(ext)) {
    fail('INVALID_RESOURCE', 'Unsupported attachment type.');
  }

  if (
    typeof value.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.sha256)
  ) {
    fail('INVALID_RESOURCE', 'Attachment checksum is invalid.');
  }

  const bytes = decodeCanonicalBase64(value.base64, value.byteLength);

  if (sha256Hex(bytes) !== value.sha256) {
    fail('INVALID_RESOURCE', 'Attachment checksum does not match.');
  }

  if (
    value.filename !== undefined &&
    !attachmentNameRank(value.filename, value.id)
  ) {
    fail('INVALID_RESOURCE', 'Invalid attachment filename.');
  }

  if (value.aliases !== undefined) {
    if (!Array.isArray(value.aliases)) {
      fail('INVALID_RESOURCE', 'Invalid attachment aliases.');
    }

    const seen = new Set<string>(
      value.filename ? [value.filename] : [`${value.id.toLowerCase()}.${ext}`],
    );

    for (const alias of value.aliases) {
      if (typeof alias !== 'string' || !attachmentNameRank(alias, value.id)) {
        fail('INVALID_RESOURCE', 'Invalid attachment filename.');
      }

      if (seen.has(alias)) fail('INVALID_RESOURCE', 'Duplicate attachment id.');
      seen.add(alias);
    }
  }

  return bytes;
}

/** Directory Cursor uses for chat image cache: sibling of the workspace DB. */
export function attachmentDirectory(workspace: WorkspaceEntry): string {
  return path.join(path.dirname(workspace.workspaceDbPath), 'images');
}

/**
 * How closely a cache filename matches an image uuid.
 * 0 = `{uuid}.ext`, 1 = `image-{uuid}.ext`, 2 = `{uuid}-{variantUuid}.ext`.
 */
function attachmentNameRank(
  name: string,
  uuid: string,
): { rank: number; extension: string } | null {
  const dot = name.lastIndexOf('.');

  if (dot <= 0) return null;
  const stem = name.slice(0, dot);
  const ext = name.slice(dot + 1).toLowerCase();

  if (!IMAGE_EXT.has(ext)) return null;
  const want = uuid.toLowerCase();
  const stemL = stem.toLowerCase();

  if (stemL === want) return { rank: 0, extension: ext };
  if (stemL === `image-${want}`) return { rank: 1, extension: ext };

  const prefix = `${want}-`;

  if (stemL.startsWith(prefix) && IMAGE_UUID.test(stemL.slice(prefix.length))) {
    return { rank: 2, extension: ext };
  }

  return null;
}

/** Locate a chat image under the workspace `images/` directory. */
export async function resolveAttachmentPath(
  workspace: WorkspaceEntry,
  uuid: string,
): Promise<{ filePath: string; extension: string } | null> {
  if (!IMAGE_UUID.test(uuid))
    fail('INVALID_RESOURCE', 'Invalid attachment id.');
  const dir = attachmentDirectory(workspace);
  let names: string[];

  try {
    const st = await fs.promises.lstat(dir);

    if (st.isSymbolicLink() || !st.isDirectory()) return null;
    names = await fs.promises.readdir(dir);
  } catch {
    return null;
  }

  const matches: Array<{
    filePath: string;
    extension: string;
    rank: number;
  }> = [];

  for (const name of names) {
    if (name === '.' || name === '..') continue;
    const ranked = attachmentNameRank(name, uuid);

    if (!ranked) continue;
    const filePath = path.join(dir, name);

    if (!staysInRoot(dir, filePath)) {
      fail('INVALID_RESOURCE', 'Attachment path escapes workspace storage.');
    }

    const lst = await fs.promises.lstat(filePath);

    if (!lst.isFile() && !lst.isSymbolicLink()) continue;
    matches.push({ filePath, extension: ranked.extension, rank: ranked.rank });
  }

  if (!matches.length) return null;

  matches.sort(
    (a, b) => a.rank - b.rank || a.filePath.localeCompare(b.filePath),
  );

  return { filePath: matches[0].filePath, extension: matches[0].extension };
}

/** Basename Cursor should write for this envelope. */
export function attachmentFilename(resource: AttachmentResource): string {
  return (
    resource.filename || `${resource.id.toLowerCase()}.${resource.extension}`
  );
}

/** True when `name` is `{uuid}.ext`, `image-{uuid}.ext`, or `{uuid}-{variant}.ext`. */
export function isAttachmentBasename(name: string): boolean {
  return attachmentUuidFromBasename(name) !== null;
}

/** Image uuid embedded in a cache basename, if the name is one Cursor writes. */
function attachmentUuidFromBasename(name: string): string | null {
  const dot = name.lastIndexOf('.');

  if (dot <= 0) return null;
  const stem = name.slice(0, dot);
  const ext = name.slice(dot + 1).toLowerCase();

  if (!IMAGE_EXT.has(ext)) return null;
  if (IMAGE_UUID.test(stem)) return stem.toLowerCase();

  const prefixed = stem.toLowerCase().startsWith('image-')
    ? stem.slice('image-'.length)
    : '';

  if (IMAGE_UUID.test(prefixed)) return prefixed.toLowerCase();
  if (stem.length < 37 || stem[36] !== '-') return null;
  const head = stem.slice(0, 36);
  const tail = stem.slice(37);

  if (IMAGE_UUID.test(head) && IMAGE_UUID.test(tail)) return head.toLowerCase();

  return null;
}

/** Basename of a path or file URL. Not a permission to open that path. */
function basenameFromReference(value: string): string | null {
  if (!value || value.length > 4096) return null;
  let filePath = value;

  if (/^file:/i.test(value)) {
    try {
      filePath = fileURLToPath(value);
    } catch {
      return null;
    }
  }

  const base = path.basename(filePath.replace(/\\/g, '/'));

  if (!base || base === '.' || base === '..' || base.length > 300) return null;

  return base;
}

/** Cache basenames for `uuid` mentioned outside `text` and `rawText`. */
export function imageBasenamesFromBubbles(
  list: BubbleRecord[] | undefined,
  uuid: string,
): string[] {
  const names: string[] = [];
  const seen = new Set<string>();

  /** Record one basename that belongs to this image uuid. */
  const add = (value: string) => {
    const base = basenameFromReference(value);

    if (!base || !attachmentNameRank(base, uuid) || seen.has(base)) return;
    seen.add(base);
    names.push(base);
  };

  /** Walk JSON. User-facing text is not a file reference. */
  const visit = (value: unknown, depth: number) => {
    if (depth > 128) return;

    if (typeof value === 'string') {
      add(value);

      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);

      return;
    }

    if (!value || typeof value !== 'object') return;

    for (const [key, nested] of Object.entries(value)) {
      if (key === 'text' || key === 'rawText') continue;
      visit(nested, depth + 1);
    }
  };

  for (const bubble of list || []) {
    if (typeof bubble.value !== 'string') continue;

    try {
      visit(JSON.parse(bubble.value), 0);
    } catch {
      /* image uuid parsing reports a broken bubble */
    }
  }

  return names;
}

/**
 * Read every distinct byte-group for one image uuid.
 * Identical copies collapse to one file. Different bytes stay separate files.
 * A referenced basename that is not on disk makes the image incomplete.
 */
export async function collectAttachmentVariants(
  workspace: WorkspaceEntry,
  uuid: string,
  referenced: string[],
): Promise<{ resources: AttachmentResource[]; missing: boolean }> {
  if (!IMAGE_UUID.test(uuid))
    fail('INVALID_RESOURCE', 'Invalid attachment id.');
  const dir = attachmentDirectory(workspace);
  let names: string[];

  try {
    const st = await fs.promises.lstat(dir);

    if (st.isSymbolicLink() || !st.isDirectory()) {
      return { resources: [], missing: true };
    }

    names = await fs.promises.readdir(dir);
  } catch {
    return { resources: [], missing: true };
  }

  const files: Array<{
    name: string;
    filePath: string;
    extension: string;
    rank: number;
  }> = [];

  for (const name of names) {
    if (name === '.' || name === '..') continue;
    const ranked = attachmentNameRank(name, uuid);

    if (!ranked) continue;
    const filePath = path.join(dir, name);

    if (!staysInRoot(dir, filePath)) {
      fail('INVALID_RESOURCE', 'Attachment path escapes workspace storage.');
    }

    const lst = await fs.promises.lstat(filePath);

    if (!lst.isFile() || lst.isSymbolicLink()) continue;

    files.push({
      name,
      filePath,
      extension: ranked.extension,
      rank: ranked.rank,
    });
  }

  const present = new Set(files.map((file) => file.name));
  const missingReferenced = referenced.some((name) => !present.has(name));

  if (!files.length) return { resources: [], missing: true };

  const groups = new Map<
    string,
    Array<{ name: string; extension: string; rank: number; bytes: Buffer }>
  >();

  for (const file of files) {
    const bytes = await fs.promises.readFile(file.filePath);
    const digest = sha256Hex(bytes);
    const group = groups.get(digest) || [];

    group.push({
      name: file.name,
      extension: file.extension,
      rank: file.rank,
      bytes,
    });

    groups.set(digest, group);
  }

  const want = new Set(referenced);
  const resources: AttachmentResource[] = [];

  for (const group of groups.values()) {
    group.sort(
      (a, b) =>
        Number(want.has(b.name)) - Number(want.has(a.name)) ||
        a.rank - b.rank ||
        a.name.localeCompare(b.name),
    );

    const chosen = group[0];
    const canonical = `${uuid.toLowerCase()}.${chosen.extension}`;
    const aliases = group.slice(1).map((file) => file.name);

    const resource = encodeAttachment(
      uuid,
      chosen.bytes,
      chosen.extension,
      chosen.name === canonical ? undefined : chosen.name,
    );

    if (aliases.length) resource.aliases = aliases;
    resources.push(resource);
  }

  resources.sort((a, b) =>
    attachmentFilename(a).localeCompare(attachmentFilename(b)),
  );

  return { resources, missing: missingReferenced };
}

/** True when every referenced basename for this uuid is covered by the export. */
export function imageExportCovers(
  attachments: AttachmentResource[],
  uuid: string,
  referenced: string[],
): boolean {
  const rows = attachments.filter(
    (row) => row.id.toLowerCase() === uuid.toLowerCase(),
  );

  if (!rows.length) return false;
  if (!referenced.length) return true;
  const names = new Set<string>();

  for (const row of rows) {
    names.add(attachmentFilename(row));

    for (const alias of row.aliases || []) names.add(alias);
  }

  return referenced.every((name) => names.has(name));
}

/** Point structured image paths at the installed basename. Leave message text alone. */
export function rewriteImageReferences(
  value: unknown,
  destByBasename: Map<string, string>,
  depth = 0,
): unknown {
  if (depth > 128) fail('UNSUPPORTED_BODY', 'Snapshot nesting limit');

  if (typeof value === 'string') {
    const base = basenameFromReference(value);
    const dest = base ? destByBasename.get(base) : undefined;

    return dest || value;
  }

  if (Array.isArray(value)) {
    return value.map((item) =>
      rewriteImageReferences(item, destByBasename, depth + 1),
    );
  }

  if (!value || typeof value !== 'object') return value;
  const rec = { ...(value as Record<string, unknown>) };

  for (const [key, nested] of Object.entries(rec)) {
    if (key === 'text' || key === 'rawText') continue;
    rec[key] = rewriteImageReferences(nested, destByBasename, depth + 1);
  }

  return rec;
}

/** Remap image paths inside composer and bubble JSON after files are installed. */
export function rewriteChatImagePaths(
  composers: Record<string, string>,
  bubbles: Record<string, BubbleRecord[]>,
  destByBasename: Map<string, string>,
): void {
  if (!destByBasename.size) return;

  for (const [id, body] of Object.entries(composers)) {
    const parsed: unknown = JSON.parse(body);

    composers[id] = JSON.stringify(
      rewriteImageReferences(parsed, destByBasename),
    );
  }

  for (const list of Object.values(bubbles)) {
    for (const bubble of list || []) {
      const parsed: unknown = JSON.parse(bubble.value);

      bubble.value = JSON.stringify(
        rewriteImageReferences(parsed, destByBasename),
      );
    }
  }
}

/** Read a local image into an export envelope. */
export async function readAttachmentFile(
  filePath: string,
  uuid: string,
  extension: string,
): Promise<AttachmentResource> {
  const bytes = await fs.promises.readFile(filePath);

  return encodeAttachment(uuid, bytes, extension);
}

/** Write an attachment; reuse identical bytes, never overwrite a different file. */
export async function writeAttachmentFile(
  workspace: WorkspaceEntry,
  resource: AttachmentResource,
): Promise<void> {
  const bytes = decodeAttachment(resource);
  const dir = attachmentDirectory(workspace);

  const dest = path.join(dir, attachmentFilename(resource));

  if (!pathInside(dir, dest)) {
    fail('INVALID_RESOURCE', 'Attachment path escapes workspace storage.');
  }

  await writeFileNoClobber(
    dir,
    dest,
    bytes,
    'An attached image already exists with different data.',
  );
}

/** Confirm a written attachment still matches the envelope. */
export async function verifyAttachmentFile(
  workspace: WorkspaceEntry,
  resource: AttachmentResource,
): Promise<void> {
  const expected = decodeAttachment(resource);
  const dir = attachmentDirectory(workspace);
  const dest = path.join(dir, attachmentFilename(resource));

  if (!pathInside(dir, dest) || !staysInRoot(dir, dest)) {
    fail('PARTIAL', 'Imported attachment is missing from workspace storage.');
  }

  let actual: Buffer;

  try {
    const lst = await fs.promises.lstat(dest);

    if (!lst.isFile() || lst.isSymbolicLink()) {
      fail('PARTIAL', 'Imported attachment is missing from workspace storage.');
    }

    actual = await fs.promises.readFile(dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      fail('PARTIAL', 'Imported attachment is missing from workspace storage.');
    }

    throw err;
  }

  if (!actual.equals(expected)) {
    fail('PARTIAL', 'Imported attachment bytes do not match the export.');
  }
}
