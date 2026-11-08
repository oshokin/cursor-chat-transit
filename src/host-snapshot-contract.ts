import { createHash } from 'node:crypto';
import { readFields } from './conversation-state';
import type { SqliteSession } from './sqlite-session';

const HEX = /^[0-9a-f]{64}$/;
const MAX_INDEX = 0xffffffff;

/** Valid native storage whose closure requires an unimplemented host codec. */
export class UnsupportedHostSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedHostSnapshotError';
  }
}

/** Only an unsupported codec plus a certified renderer closure allows omission. */
export function requireRendererFallback(
  error: unknown,
  rendererComplete: boolean,
): void {
  if (!(error instanceof UnsupportedHostSnapshotError)) throw error;
  if (!rendererComplete)
    throw new Error(
      'Unsupported native snapshot cannot be omitted without a valid complete renderer closure.',
    );
}

/** Installed Cursor modules 81504/51374: no protobuf reconstruction or guessing. */
export async function verifyHostRoot(
  db: SqliteSession,
  manifest: Record<string, unknown>,
): Promise<void> {
  let unsupported: string | undefined;

  const omit = (message: string): void => {
    unsupported ??= message;
  };

  const load = async (key: string): Promise<Buffer> => {
    let value: Buffer | undefined;

    await db.rows(
      'SELECT value FROM cursorDiskKV WHERE key=?;',
      [key],
      (row) => {
        if (row[0] instanceof Uint8Array) value = Buffer.from(row[0]);
      },
    );

    if (!value)
      throw new Error('Host snapshot required root or closure row is missing.');

    return value;
  };

  const blob = async (id: string): Promise<Buffer> => {
    const bytes = await load(`agentKv:blob:${id}`);

    if (createHash('sha256').update(bytes).digest('hex') !== id)
      throw new Error('Host snapshot content hash mismatch.');

    return bytes;
  };

  // These roles have no outgoing blob references in the installed descriptors.
  // Structured roles require their own exhaustive typed codec; fail closed.
  const state = async (bytes: Buffer): Promise<void> => {
    for (const field of readFields(bytes)) {
      if ([3, 6, 7, 8, 11, 12, 13, 15, 16, 31].includes(field.field))
        omit('Unsupported host snapshot structured closure.');

      if (field.field === 1) {
        if (field.wire !== 2 || field.bytes.length !== 32)
          throw new Error('Host snapshot blob reference is invalid.');
        await blob(field.bytes.toString('hex'));
      }

      if (field.field > 50 || [2, 41, 48].includes(field.field))
        omit('Unsupported host snapshot state field.');
    }
  };

  const root = await blob(String(manifest.latestRootBlobIdHex));

  if (manifest.manifestVersion === 1) {
    await state(root);
    if (unsupported) throw new UnsupportedHostSnapshotError(unsupported);

    return;
  }

  if (root.length < 4)
    throw new Error('Host snapshot root header is truncated.');
  const end = 4 + root.readUInt32LE(0);

  if (end > root.length)
    throw new Error('Host snapshot root header overruns blob.');
  let header: Record<string, unknown>;

  try {
    header = JSON.parse(root.subarray(4, end).toString('utf8')) as Record<
      string,
      unknown
    >;

    if (!header || typeof header !== 'object' || Array.isArray(header))
      throw new Error();
  } catch {
    throw new Error('Host snapshot root header is invalid.');
  }

  if (
    header.version !== 1 ||
    !Array.isArray(header.promptPrefix) ||
    !Array.isArray(header.summarySlot) ||
    [...header.promptPrefix, ...header.summarySlot].some(
      (id) => typeof id !== 'string' || !HEX.test(id),
    ) ||
    (header.lastTurn !== undefined &&
      (typeof header.lastTurn !== 'string' || !HEX.test(header.lastTurn))) ||
    header.structureId !== manifest.latestStructureIdHex ||
    (header.epoch ?? 0) !== (manifest.conversionEpoch ?? 0)
  )
    throw new Error('Host snapshot root does not match manifest.');
  const heads = manifest.listHeads as Record<string, number>;

  for (const [list, name] of [
    ['turns', 'turns'],
    ['prompt', 'body'],
    ['archives', 'archives'],
  ] as const) {
    const range = header[name];

    if (
      !Array.isArray(range) ||
      range.length !== 2 ||
      !range.every((n) => Number.isInteger(n) && n >= 0 && n <= MAX_INDEX) ||
      range[0] > range[1] ||
      range[1] !== heads[list]
    )
      throw new Error(
        'Host snapshot root range does not match manifest list heads.',
      );
    if (range[1] - range[0] > 100_000)
      throw new Error('Host snapshot list size exceeds verification limit.');

    for (let index = range[0]; index < range[1]; index++) {
      const row = await load(
        `agentHost:${list}:${String(index).padStart(12, '0')}`,
      );

      if (list === 'archives') {
        if (
          row.length < 42 ||
          row.length !== 42 + row.readUInt16LE(32) * 32 ||
          row.readUInt32LE(row.length - 4) < row.readUInt32LE(row.length - 8)
        )
          throw new Error('Host snapshot archive row is invalid.');

        await blob(row.subarray(0, 32).toString('hex'));
        for (let offset = 34; offset < row.length - 8; offset += 32)
          await blob(row.subarray(offset, offset + 32).toString('hex'));
        omit('Unsupported host snapshot archive closure.');
        continue;
      }

      if (row.length !== 32)
        throw new Error('Host snapshot list row is not a blob id.');
      await blob(row.toString('hex'));
      if (list === 'turns') omit('Unsupported host snapshot turn closure.');
    }
  }

  if (header.lastTurn !== undefined) await blob(String(header.lastTurn));
  if (header.lastTurn !== undefined)
    omit('Unsupported host snapshot turn closure.');
  for (const id of [...header.promptPrefix, ...header.summarySlot])
    await blob(String(id));
  await state(root.subarray(end));

  // A structure id is a hash of materialized protobuf, not a stored blob.
  // Only the no-list case can be certified without a full Cursor codec.
  if (manifest.latestStructureIdHex !== undefined) {
    const materialized =
      header.promptPrefix.length === 0 &&
      header.summarySlot.length === 0 &&
      (header.body as number[])[1] === (header.body as number[])[0] &&
      (header.turns as number[])[1] === (header.turns as number[])[0] &&
      header.lastTurn === undefined;

    if (
      materialized &&
      createHash('sha256').update(root.subarray(end)).digest('hex') !==
        manifest.latestStructureIdHex
    )
      throw new Error('Host snapshot materialized structure hash mismatch.');
    if (
      header.promptPrefix.length ||
      header.summarySlot.length ||
      (header.body as number[])[1] !== (header.body as number[])[0] ||
      createHash('sha256').update(root.subarray(end)).digest('hex') !==
        manifest.latestStructureIdHex
    )
      omit('Unsupported host snapshot materialized structure verification.');
  }

  if (unsupported) throw new UnsupportedHostSnapshotError(unsupported);
}
