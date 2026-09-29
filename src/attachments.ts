import fs from 'node:fs';
import path from 'node:path';
import {
  decodeCanonicalBase64,
  resourceError as fail,
  MAX_RESOURCE_BYTES,
  sha256Hex,
} from './resource-bytes';
import { pathInside, staysInRoot, writeFileNoClobber } from './resource-files';
import type { AttachmentResource, WorkspaceEntry } from './types';

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
): AttachmentResource {
  if (!IMAGE_UUID.test(id)) fail('INVALID_RESOURCE', 'Invalid attachment id.');
  const ext = extension.toLowerCase();
  if (!IMAGE_EXT.has(ext)) {
    fail('INVALID_RESOURCE', 'Unsupported attachment type.');
  }
  if (bytes.length > MAX_RESOURCE_BYTES) {
    fail('INVALID_RESOURCE', 'Attachment exceeds size limit.');
  }
  return {
    id,
    base64: bytes.toString('base64'),
    byteLength: bytes.length,
    sha256: sha256Hex(bytes),
    extension: ext,
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
  return bytes;
}

/** Directory Cursor uses for chat image cache: sibling of the workspace DB. */
export function attachmentDirectory(workspace: WorkspaceEntry): string {
  return path.join(path.dirname(workspace.workspaceDbPath), 'images');
}

/** Locate `{uuid}.{ext}` under the workspace `images/` directory. */
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
  const want = uuid.toLowerCase();
  const matches: Array<{ filePath: string; extension: string }> = [];
  for (const name of names) {
    if (name === '.' || name === '..') continue;
    const dot = name.lastIndexOf('.');
    const stem = dot <= 0 ? name : name.slice(0, dot);
    const ext = (dot <= 0 ? '' : name.slice(dot + 1)).toLowerCase();
    if (stem.toLowerCase() !== want || !IMAGE_EXT.has(ext)) continue;
    const filePath = path.join(dir, name);
    if (!staysInRoot(dir, filePath)) {
      fail('INVALID_RESOURCE', 'Attachment path escapes workspace storage.');
    }
    const lst = await fs.promises.lstat(filePath);
    if (!lst.isFile() && !lst.isSymbolicLink()) continue;
    matches.push({ filePath, extension: ext });
  }
  if (matches.length > 1) {
    fail('RESOURCE_CONFLICT', 'Ambiguous attachment files for the same id.');
  }
  return matches[0] || null;
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
  const dest = path.join(
    dir,
    `${resource.id.toLowerCase()}.${resource.extension}`,
  );
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
  const found = await resolveAttachmentPath(workspace, resource.id);
  if (!found) {
    fail('PARTIAL', 'Imported attachment is missing from workspace storage.');
  }
  const actual = await fs.promises.readFile(found.filePath);
  if (!actual.equals(expected)) {
    fail('PARTIAL', 'Imported attachment bytes do not match the export.');
  }
}
