import { pathInside, staysInRoot, writeFileNoClobber } from './resource-files';
import {
  MAX_RESOURCE_BYTES,
  sha256Hex,
  decodeCanonicalBase64,
  resourceError as fail,
} from './resource-bytes';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { BubbleRecord, CanvasResource, WorkspaceEntry } from './types';

/** Allowlisted Cursor canvas basename: `{name}.canvas.tsx`. */
export const CANVAS_FILENAME =
  /^[A-Za-z0-9][A-Za-z0-9._+-]{0,180}\.canvas\.tsx$/;

/** Canvas file carried in an export. */
export type { CanvasResource };

/** True when the name is a legal canvas basename. */
export function isCanvasFilename(name: string): boolean {
  return CANVAS_FILENAME.test(name);
}

/**
 * Cursor project-directory slug.
 * Matches workbench `zOi`: non-alphanumerics become `-`, runs collapse, ends trim.
 */
export function cursorProjectSlug(fsPath: string): string | null {
  if (!fsPath || fsPath.includes('\0')) return null;

  const slug = fsPath
    .replace(/[^A-Za-z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

  return slug || null;
}

/** `{home}/.cursor/projects/{slug}/canvases` for this workspace, or null. */
export function canvasesDirectoryForWorkspace(
  workspace: WorkspaceEntry,
): string | null {
  const raw = workspace.identity?.uri.path;

  if (typeof raw !== 'string' || !raw) return null;
  const slug = cursorProjectSlug(raw);

  if (!slug) return null;

  return path.join(os.homedir(), '.cursor', 'projects', slug, 'canvases');
}

/** Basename of a canvas under a `canvases` directory. Other paths are ignored. */
export function canvasFilenameFromRef(value: string): string | null {
  if (typeof value !== 'string' || !value) return null;
  let filePath = value;

  if (/^file:/i.test(value)) {
    try {
      filePath = fileURLToPath(value);
    } catch {
      try {
        const raw = value.replace(/^file:\/\//i, '');

        filePath = decodeURIComponent(raw.split('?')[0] || '');
      } catch {
        return null;
      }
    }
  }

  const parts = filePath.replace(/\\/g, '/').split('/');
  const base = parts.pop() || '';
  const parent = parts.pop();

  if (parent !== 'canvases') return null;
  let name: string;

  try {
    name = decodeURIComponent(base);
  } catch {
    name = base;
  }

  return isCanvasFilename(name) ? name : null;
}

/** Basename from a URI-shaped object when it points at `canvases/{name}.canvas.tsx`. */
function canvasFilenameFromUriObject(
  rec: Record<string, unknown>,
): string | null {
  for (const key of ['path', 'fsPath', 'external'] as const) {
    const value = rec[key];

    if (typeof value === 'string') {
      const name = canvasFilenameFromRef(value);

      if (name) return name;
    }
  }

  return null;
}

/** True when the object looks like a file URI, not an arbitrary JSON map. */
function looksLikeUriObject(rec: Record<string, unknown>): boolean {
  return (
    typeof rec.path === 'string' ||
    typeof rec.fsPath === 'string' ||
    typeof rec.external === 'string' ||
    rec.scheme === 'file'
  );
}

/** Canvas basenames reachable from one chat. Paths in JSON are never opened. */
export function canvasFilenamesFromChat(
  bodyText: string | undefined,
  bubbles: BubbleRecord[] | undefined,
): string[] {
  const names: string[] = [];
  const seen = new Set<string>();

  /** Record a unique canvas basename. */
  const add = (name: string | null) => {
    if (!name || seen.has(name)) return;
    seen.add(name);
    names.push(name);
  };

  /** Walk JSON for canvas URIs. Skip user-facing `text` and `rawText`. */
  const visit = (value: unknown, depth: number) => {
    if (depth > 128) fail('UNSUPPORTED_BODY', 'Snapshot nesting limit');

    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);

      return;
    }

    if (!value || typeof value !== 'object') return;
    const rec = value as Record<string, unknown>;

    if (typeof rec.relativeWorkspacePath === 'string') {
      add(canvasFilenameFromRef(rec.relativeWorkspacePath));
    }

    if (looksLikeUriObject(rec)) add(canvasFilenameFromUriObject(rec));

    for (const [key, nested] of Object.entries(rec)) {
      if (key === 'text' || key === 'rawText') continue;
      visit(nested, depth + 1);
    }
  };

  if (typeof bodyText === 'string' && bodyText) {
    try {
      visit(JSON.parse(bodyText), 0);
    } catch {
      /* composer inspect handles malformed bodies */
    }
  }

  for (const bubble of bubbles || []) {
    if (typeof bubble.value !== 'string') continue;

    try {
      visit(JSON.parse(bubble.value), 0);
    } catch {
      /* bubble inspect handles malformed payloads */
    }
  }

  return names;
}

/** Envelope for one canvas file. */
export function encodeCanvas(filename: string, bytes: Buffer): CanvasResource {
  if (!isCanvasFilename(filename)) {
    fail('INVALID_RESOURCE', 'Invalid canvas filename.');
  }

  if (!Buffer.isBuffer(bytes)) throw new TypeError('Expected Buffer');

  if (bytes.length > MAX_RESOURCE_BYTES) {
    fail('INVALID_RESOURCE', 'Canvas exceeds size limit.');
  }

  return {
    filename,
    base64: bytes.toString('base64'),
    byteLength: bytes.length,
    sha256: sha256Hex(bytes),
  };
}

/** Validate and decode a canvas envelope. */
export function decodeCanvas(value: CanvasResource): Buffer {
  if (!isCanvasFilename(value.filename)) {
    fail('INVALID_RESOURCE', 'Invalid canvas filename.');
  }

  if (
    typeof value.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.sha256)
  ) {
    fail('INVALID_RESOURCE', 'Canvas checksum is invalid.');
  }

  const bytes = decodeCanonicalBase64(value.base64, value.byteLength);

  if (sha256Hex(bytes) !== value.sha256) {
    fail('INVALID_RESOURCE', 'Canvas checksum does not match.');
  }

  return bytes;
}

/** Allowlisted `{canvasesDir}/{basename}` only. */
export function canvasFilePath(canvasesDir: string, filename: string): string {
  if (!isCanvasFilename(filename)) {
    fail('INVALID_RESOURCE', 'Invalid canvas filename.');
  }

  const dest = path.join(canvasesDir, filename);

  if (path.basename(dest) !== filename || !pathInside(canvasesDir, dest)) {
    fail('INVALID_RESOURCE', 'Canvas path escapes the canvases directory.');
  }

  return dest;
}

/** Read a canvas from the allowlisted directory only. */
export async function readCanvasFile(
  canvasesDir: string,
  filename: string,
): Promise<CanvasResource | null> {
  const dest = canvasFilePath(canvasesDir, filename);

  try {
    const dirStat = await fs.promises.lstat(canvasesDir);

    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return null;
  } catch {
    return null;
  }

  if (!staysInRoot(canvasesDir, dest)) return null;

  try {
    const lst = await fs.promises.lstat(dest);

    if (!lst.isFile() || lst.isSymbolicLink()) return null;
    const bytes = await fs.promises.readFile(dest);

    return encodeCanvas(filename, bytes);
  } catch {
    return null;
  }
}

/** Write a canvas; reuse identical bytes, never overwrite a different file. */
export async function writeCanvasFile(
  canvasesDir: string,
  resource: CanvasResource,
): Promise<string> {
  const bytes = decodeCanvas(resource);
  const dest = canvasFilePath(canvasesDir, resource.filename);

  await writeFileNoClobber(
    canvasesDir,
    dest,
    bytes,
    'A Cursor canvas file already exists with different data.',
  );

  return dest;
}

/** Fail if the on-disk canvas is missing or its bytes differ. */
export async function verifyCanvasFile(
  canvasesDir: string,
  resource: CanvasResource,
): Promise<void> {
  const expected = decodeCanvas(resource);
  const found = await readCanvasFile(canvasesDir, resource.filename);

  if (!found) {
    fail('PARTIAL', 'Imported canvas is missing from the canvases directory.');
  }

  const actual = decodeCanvas(found);

  if (!actual.equals(expected)) {
    fail('PARTIAL', 'Imported canvas bytes do not match the export.');
  }
}

/** `file:` URL for a local canvas path. */
export function fileUriForCanvas(absPath: string): string {
  return pathToFileURL(absPath).href;
}

/** Point a URI-shaped object at the destination canvas path. */
function applyCanvasUri(rec: Record<string, unknown>, absPath: string): void {
  const uri = new URL(fileUriForCanvas(absPath));

  rec.path = decodeURIComponent(uri.pathname);
  rec.authority = uri.host;
  rec.query = '';
  rec.fragment = '';
  rec.fsPath = absPath;
  rec.scheme = 'file';
  rec.external = fileUriForCanvas(absPath);
}

/** Rewrite structured canvas URIs. Leave `text` and `rawText` unchanged. */
export function rewriteCanvasReferences(
  value: unknown,
  destByFilename: Map<string, string>,
  depth = 0,
): unknown {
  if (depth > 128) fail('UNSUPPORTED_BODY', 'Snapshot nesting limit');

  if (Array.isArray(value)) {
    return value.map((item) =>
      rewriteCanvasReferences(item, destByFilename, depth + 1),
    );
  }

  if (!value || typeof value !== 'object') return value;
  const rec = { ...(value as Record<string, unknown>) };

  if (typeof rec.relativeWorkspacePath === 'string') {
    const name = canvasFilenameFromRef(rec.relativeWorkspacePath);
    const dest = name ? destByFilename.get(name) : undefined;

    if (dest) rec.relativeWorkspacePath = dest;
  }

  if (looksLikeUriObject(rec)) {
    const name = canvasFilenameFromUriObject(rec);
    const dest = name ? destByFilename.get(name) : undefined;

    if (dest) applyCanvasUri(rec, dest);
  }

  for (const [key, nested] of Object.entries(rec)) {
    if (key === 'text' || key === 'rawText') continue;
    if (key === 'relativeWorkspacePath') continue;
    rec[key] = rewriteCanvasReferences(nested, destByFilename, depth + 1);
  }

  return rec;
}

/** Remap canvas URIs inside composer and bubble JSON after files are installed. */
export function rewriteChatCanvasUris(
  composers: Record<string, string>,
  bubbles: Record<string, BubbleRecord[]>,
  destByFilename: Map<string, string>,
): void {
  if (!destByFilename.size) return;

  for (const [id, body] of Object.entries(composers)) {
    const parsed: unknown = JSON.parse(body);

    composers[id] = JSON.stringify(
      rewriteCanvasReferences(parsed, destByFilename),
    );
  }

  for (const list of Object.values(bubbles)) {
    for (const bubble of list || []) {
      const parsed: unknown = JSON.parse(bubble.value);

      bubble.value = JSON.stringify(
        rewriteCanvasReferences(parsed, destByFilename),
      );
    }
  }
}
