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
import type { BubbleRecord, PlanResource } from './types';

/** Allowlisted Cursor plan basename: `{name}.plan.md`. */
export const PLAN_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,180}\.plan\.md$/;

/** Default Cursor plan directory on this machine (`~/.cursor/plans`). */
export function defaultPlansDirectory(): string {
  return path.join(os.homedir(), '.cursor', 'plans');
}

/** True when the name is a legal plan basename for this directory. */
export function isPlanFilename(name: string): boolean {
  return PLAN_FILENAME.test(name);
}

/** Basename of a Cursor plan file from a file URI or path. */
export function planFilenameFromRef(
  /** Plan path or URI string. */
  value: string,
): string | null {
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

  const base = path.basename(filePath.replace(/\\/g, '/'));
  let name: string;

  try {
    name = decodeURIComponent(base);
  } catch {
    name = base;
  }

  return isPlanFilename(name) ? name : null;
}

/** Basename from a VS Code-style URI object, never from markdown text. */
function planFilenameFromUriObject(
  rec: Record<string, unknown>,
): string | null {
  for (const key of ['path', 'fsPath', 'external'] as const) {
    const value = rec[key];

    if (typeof value === 'string') {
      const name = planFilenameFromRef(value);

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

/** Plan basenames reachable from one chat's body and bubbles. */
export function planFilenamesFromChat(
  bodyText: string | undefined,
  /** Bubble records keyed by composer id. */
  bubbles: BubbleRecord[] | undefined,
): string[] {
  const names: string[] = [];
  const seen = new Set<string>();

  /** Record a unique plan basename, ignoring empty or duplicate names. */
  const add = (
    /** Plan basename, or null. */
    name: string | null,
  ) => {
    if (!name || seen.has(name)) return;
    seen.add(name);
    names.push(name);
  };

  /** Walk JSON looking for plan URIs; skip user-facing `text` and `rawText`. */
  const visit = (
    /** Nested JSON value. */
    value: unknown,
    /** Current walk depth. */
    depth: number,
  ) => {
    if (depth > 128) fail('UNSUPPORTED_BODY', 'Snapshot nesting limit');

    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);

      return;
    }

    if (!value || typeof value !== 'object') return;
    const rec = value as Record<string, unknown>;

    if (typeof rec.planUri === 'string') add(planFilenameFromRef(rec.planUri));
    if (looksLikeUriObject(rec)) add(planFilenameFromUriObject(rec));

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

/** Envelope for one plan file: basename plus canonical bytes. */
export function encodePlan(
  /** Basename, not a path. */
  filename: string,
  bytes: Buffer,
): PlanResource {
  if (!isPlanFilename(filename)) {
    fail('INVALID_RESOURCE', 'Invalid plan filename.');
  }

  if (!Buffer.isBuffer(bytes)) throw new TypeError('Expected Buffer');

  if (bytes.length > MAX_RESOURCE_BYTES) {
    fail('INVALID_RESOURCE', 'Plan exceeds size limit.');
  }

  return {
    filename,
    base64: bytes.toString('base64'),
    byteLength: bytes.length,
    sha256: sha256Hex(bytes),
  };
}

/** Validate and decode a plan envelope; checksums must match. */
export function decodePlan(
  /** Plan envelope to decode. */
  value: PlanResource,
): Buffer {
  if (!isPlanFilename(value.filename)) {
    fail('INVALID_RESOURCE', 'Invalid plan filename.');
  }

  if (
    typeof value.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.sha256)
  ) {
    fail('INVALID_RESOURCE', 'Plan checksum is invalid.');
  }

  const bytes = decodeCanonicalBase64(value.base64, value.byteLength);

  if (sha256Hex(bytes) !== value.sha256) {
    fail('INVALID_RESOURCE', 'Plan checksum does not match.');
  }

  return bytes;
}

/** Allowlisted `{plansDir}/{basename}` only. Never a path from JSON. */
export function planFilePath(
  /** Allowlisted plans directory. */
  plansDir: string,
  /** Basename, not a path. */
  filename: string,
): string {
  if (!isPlanFilename(filename)) {
    fail('INVALID_RESOURCE', 'Invalid plan filename.');
  }

  const dest = path.join(plansDir, filename);

  if (path.basename(dest) !== filename || !pathInside(plansDir, dest)) {
    fail('INVALID_RESOURCE', 'Plan path escapes the plans directory.');
  }

  return dest;
}

/** Read a plan from the allowlisted directory only. */
export async function readPlanFile(
  /** Allowlisted plans directory. */
  plansDir: string,
  /** Basename, not a path. */
  filename: string,
): Promise<PlanResource | null> {
  const dest = planFilePath(plansDir, filename);

  try {
    const dirStat = await fs.promises.lstat(plansDir);

    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return null;
  } catch {
    return null;
  }

  if (!staysInRoot(plansDir, dest)) return null;

  try {
    const lst = await fs.promises.lstat(dest);

    if (!lst.isFile() || lst.isSymbolicLink()) return null;
    const bytes = await fs.promises.readFile(dest);

    return encodePlan(filename, bytes);
  } catch {
    return null;
  }
}

/** Write a plan; reuse identical bytes, never overwrite a different file. */
export async function writePlanFile(
  /** Allowlisted plans directory. */
  plansDir: string,
  /** Resource envelope to write or check. */
  resource: PlanResource,
): Promise<string> {
  const bytes = decodePlan(resource);
  const dest = planFilePath(plansDir, resource.filename);

  await writeFileNoClobber(
    plansDir,
    dest,
    bytes,
    'A Cursor plan file already exists with different data.',
  );

  return dest;
}

/** Fail if the on-disk plan is missing or its bytes differ from the export. */
export async function verifyPlanFile(
  /** Allowlisted plans directory. */
  plansDir: string,
  /** Resource envelope to write or check. */
  resource: PlanResource,
): Promise<void> {
  const expected = decodePlan(resource);
  const found = await readPlanFile(plansDir, resource.filename);

  if (!found) {
    fail('PARTIAL', 'Imported plan is missing from the plans directory.');
  }

  const actual = decodePlan(found);

  if (!actual.equals(expected)) {
    fail('PARTIAL', 'Imported plan bytes do not match the export.');
  }
}

/** `file:` URL for a local plan path; used when rewriting structured URIs. */
export function fileUriForPlan(absPath: string): string {
  return pathToFileURL(absPath).href;
}

/** Point a URI-shaped object at the destination plan path. */
function applyPlanUri(rec: Record<string, unknown>, absPath: string): void {
  const uri = new URL(fileUriForPlan(absPath));

  rec.path = decodeURIComponent(uri.pathname);
  rec.authority = uri.host;
  rec.query = '';
  rec.fragment = '';
  rec.fsPath = absPath;
  rec.scheme = 'file';
  rec.external = fileUriForPlan(absPath);
}

/** Rewrite structured plan URIs. Never substring-replace plan markdown. */
export function rewritePlanReferences(
  /** Composer or bubble JSON to rewrite. */
  value: unknown,
  /** Source basename to the installed path. */
  destByFilename: Map<string, string>,
  /** Remaining recursion depth. */
  depth = 0,
): unknown {
  if (depth > 128) fail('UNSUPPORTED_BODY', 'Snapshot nesting limit');

  if (Array.isArray(value)) {
    return value.map((item) =>
      rewritePlanReferences(item, destByFilename, depth + 1),
    );
  }

  if (!value || typeof value !== 'object') return value;
  const rec = { ...(value as Record<string, unknown>) };

  if (typeof rec.planUri === 'string') {
    const name = planFilenameFromRef(rec.planUri);
    const dest = name ? destByFilename.get(name) : undefined;

    if (dest) rec.planUri = fileUriForPlan(dest);
  }

  if (looksLikeUriObject(rec)) {
    const name = planFilenameFromUriObject(rec);
    const dest = name ? destByFilename.get(name) : undefined;

    if (dest) applyPlanUri(rec, dest);
  }

  for (const [key, nested] of Object.entries(rec)) {
    if (key === 'text' || key === 'rawText') continue;
    if (key === 'planUri') continue;
    rec[key] = rewritePlanReferences(nested, destByFilename, depth + 1);
  }

  return rec;
}

/** Remap plan URIs inside composer and bubble JSON after files are installed. */
export function rewriteChatPlanUris(
  /** Composer bodies keyed by id. */
  composers: Record<string, string>,
  /** Bubble records keyed by composer id. */
  bubbles: Record<string, BubbleRecord[]>,
  /** Source basename to the installed path. */
  destByFilename: Map<string, string>,
): void {
  if (!destByFilename.size) return;

  for (const [id, body] of Object.entries(composers)) {
    const parsed: unknown = JSON.parse(body);

    composers[id] = JSON.stringify(
      rewritePlanReferences(parsed, destByFilename),
    );
  }

  for (const list of Object.values(bubbles)) {
    for (const bubble of list || []) {
      const parsed: unknown = JSON.parse(bubble.value);

      bubble.value = JSON.stringify(
        rewritePlanReferences(parsed, destByFilename),
      );
    }
  }
}
