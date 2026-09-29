import { createHash } from 'node:crypto';
import { TransferError } from './types';

/** Hard cap on one kv, image, or plan payload. */
export const MAX_RESOURCE_BYTES = 32 * 1024 * 1024;

/** Throw a TransferError with a stable code. */
export function resourceError(code: string, message: string): never {
  const err = new TransferError(message);
  err.code = code;
  throw err;
}

/** SHA-256 of raw bytes as lowercase hex. */
export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Decode canonical base64 with standard padding; reject whitespace and aliases. */
export function decodeCanonicalBase64(
  encoded: string,
  byteLength: number,
): Buffer {
  if (typeof encoded !== 'string') {
    resourceError('INVALID_RESOURCE', 'Resource payload is not valid base64.');
  }
  if (
    !Number.isInteger(byteLength) ||
    byteLength < 0 ||
    byteLength > MAX_RESOURCE_BYTES
  ) {
    resourceError('INVALID_RESOURCE', 'Resource byteLength is invalid.');
  }
  if (encoded.length > Math.ceil(MAX_RESOURCE_BYTES / 3) * 4) {
    resourceError('INVALID_RESOURCE', 'Resource payload exceeds size limit.');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length !== byteLength || bytes.toString('base64') !== encoded) {
    resourceError(
      'INVALID_RESOURCE',
      'Resource payload does not match byteLength.',
    );
  }
  return bytes;
}
