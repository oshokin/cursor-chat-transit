import { decodeAttachment, encodeAttachment } from './attachments';
import { decodeCanvas, encodeCanvas } from './canvases';
import { isBlobKey } from './chat-dependencies';
import { decodePlan, encodePlan } from './plans';
import {
  decodeCanonicalBase64,
  resourceError as fail,
  MAX_RESOURCE_BYTES,
  sha256Hex,
} from './resource-bytes';
import type {
  AttachmentResource,
  CanvasResource,
  ExportResources,
  KvResource,
  PlanResource,
  SqliteBytes,
} from './types';

/** Cap on the sum of decoded resource bytes in one envelope. */
export const MAX_TOTAL_RESOURCE_BYTES = 256 * 1024 * 1024;

/** Cap on kv + image + plan + canvas entries in one envelope. */
export const MAX_RESOURCE_COUNT = 10_000;

/** Envelope for a SQLite TEXT or BLOB value. */
export function encodeSqliteBytes(
  bytes: Buffer,
  storageClass: 'text' | 'blob',
): SqliteBytes {
  if (!Buffer.isBuffer(bytes)) throw new TypeError('Expected Buffer');

  if (bytes.length > MAX_RESOURCE_BYTES) {
    fail('INVALID_RESOURCE', 'Resource exceeds size limit.');
  }

  return {
    storageClass,
    base64: bytes.toString('base64'),
    byteLength: bytes.length,
    sha256: sha256Hex(bytes),
  };
}

/** Validate and decode a SQLite resource envelope. */
export function decodeSqliteBytes(
  /** SQLite hex or text bytes to decode. */
  value: SqliteBytes,
): Buffer {
  if (value.storageClass !== 'text' && value.storageClass !== 'blob') {
    fail('INVALID_RESOURCE', 'Unsupported SQLite storage class.');
  }

  if (
    typeof value.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.sha256)
  ) {
    fail('INVALID_RESOURCE', 'Resource checksum is invalid.');
  }

  const bytes = decodeCanonicalBase64(value.base64, value.byteLength);

  if (sha256Hex(bytes) !== value.sha256) {
    fail('INVALID_RESOURCE', 'Resource checksum does not match.');
  }

  return bytes;
}

/** Validate a resources object from an export file. */
export function parseExportResources(
  /** Export resource list to parse. */
  value: unknown,
  opts?: {
    /** When true, skip malformed resource payloads instead of failing the whole envelope. */
    skipInvalidPayloads?: boolean;
  },
): ExportResources {
  if (value === undefined) {
    return { kv: [], attachments: [], plans: [], canvases: [] };
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_RESOURCE', 'Invalid export resources.');
  }

  const rec = value as Record<string, unknown>;

  if (!Array.isArray(rec.kv) || !Array.isArray(rec.attachments)) {
    fail('INVALID_RESOURCE', 'Invalid export resources.');
  }

  const kv: KvResource[] = [];
  const seen = new Set<string>();
  let total = 0;

  for (const row of rec.kv) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      fail('INVALID_RESOURCE', 'Invalid export resource record.');
    }

    const item = row as KvResource;

    if (typeof item.key !== 'string' || !isBlobKey(item.key)) {
      fail(
        'INVALID_RESOURCE',
        'Export contains a resource key that is not allowed.',
      );
    }

    if (seen.has(item.key)) fail('INVALID_RESOURCE', 'Duplicate resource key.');
    seen.add(item.key);
    let bytes: Buffer;

    try {
      bytes = decodeSqliteBytes(item.value);
    } catch (err) {
      if (opts?.skipInvalidPayloads) continue;

      throw err;
    }

    total += bytes.length;

    if (
      kv.length + 1 > MAX_RESOURCE_COUNT ||
      total > MAX_TOTAL_RESOURCE_BYTES
    ) {
      fail('INVALID_RESOURCE', 'Resource set exceeds size limit.');
    }

    kv.push({
      key: item.key,
      value: encodeSqliteBytes(bytes, item.value.storageClass),
    });
  }

  const attachments: AttachmentResource[] = [];
  const seenImg = new Set<string>();

  for (const row of rec.attachments) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      fail('INVALID_RESOURCE', 'Invalid export attachment record.');
    }

    const item = row as AttachmentResource;
    let bytes: Buffer;

    try {
      bytes = decodeAttachment(item);
    } catch (err) {
      if (opts?.skipInvalidPayloads) continue;

      throw err;
    }

    const id = item.id.toLowerCase();

    const encoded = encodeAttachment(
      item.id,
      bytes,
      item.extension,
      item.filename,
    );

    if (item.aliases?.length) encoded.aliases = item.aliases;
    const identity = encoded.filename || id;

    if (seenImg.has(identity)) {
      fail('INVALID_RESOURCE', 'Duplicate attachment id.');
    }

    seenImg.add(identity);
    total += bytes.length;

    if (
      attachments.length + 1 > MAX_RESOURCE_COUNT ||
      total > MAX_TOTAL_RESOURCE_BYTES
    ) {
      fail('INVALID_RESOURCE', 'Resource set exceeds size limit.');
    }

    attachments.push(encoded);
  }

  const plans: PlanResource[] = [];
  const seenPlan = new Set<string>();
  const planRows = rec.plans === undefined ? [] : rec.plans;

  if (!Array.isArray(planRows)) {
    fail('INVALID_RESOURCE', 'Invalid export resources.');
  }

  for (const row of planRows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      fail('INVALID_RESOURCE', 'Invalid export plan record.');
    }

    const item = row as PlanResource;
    let bytes: Buffer;

    try {
      bytes = decodePlan(item);
    } catch (err) {
      if (opts?.skipInvalidPayloads) continue;

      throw err;
    }

    if (seenPlan.has(item.filename)) {
      fail('INVALID_RESOURCE', 'Duplicate plan filename.');
    }

    seenPlan.add(item.filename);
    total += bytes.length;

    if (
      kv.length + attachments.length + plans.length + 1 > MAX_RESOURCE_COUNT ||
      total > MAX_TOTAL_RESOURCE_BYTES
    ) {
      fail('INVALID_RESOURCE', 'Resource set exceeds size limit.');
    }

    plans.push(encodePlan(item.filename, bytes));
  }

  const canvases: CanvasResource[] = [];
  const seenCanvas = new Set<string>();
  const canvasRows = rec.canvases === undefined ? [] : rec.canvases;

  if (!Array.isArray(canvasRows)) {
    fail('INVALID_RESOURCE', 'Invalid export resources.');
  }

  for (const row of canvasRows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      fail('INVALID_RESOURCE', 'Invalid export canvas record.');
    }

    const item = row as CanvasResource;
    let bytes: Buffer;

    try {
      bytes = decodeCanvas(item);
    } catch (err) {
      if (opts?.skipInvalidPayloads) continue;

      throw err;
    }

    if (seenCanvas.has(item.filename)) {
      fail('INVALID_RESOURCE', 'Duplicate canvas filename.');
    }

    seenCanvas.add(item.filename);
    total += bytes.length;

    if (
      kv.length + attachments.length + plans.length + canvases.length + 1 >
        MAX_RESOURCE_COUNT ||
      total > MAX_TOTAL_RESOURCE_BYTES
    ) {
      fail('INVALID_RESOURCE', 'Resource set exceeds size limit.');
    }

    canvases.push(encodeCanvas(item.filename, bytes));
  }

  return { kv, attachments, plans, canvases };
}
