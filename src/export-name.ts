import { createHash } from 'node:crypto';

/** How the suggested filename describes the chats in this export. */
export type ExportNameSelection =
  | {
      /** The file contains every chat in the workspace. */
      kind: 'all';
      /** Number of chats included in the file. */
      count: number;
    }
  | {
      /** The file contains a single named chat. */
      kind: 'selected';
      /** Always `1` for a one-chat selection. */
      count: 1;
      /** Title used in the filename stem. */
      chatTitle: string;
    }
  | {
      /** The file contains several selected chats. */
      kind: 'selected';
      /** Number of chats included in the file. */
      count: number;
      /** Optional title when one chat still dominates the stem. */
      chatTitle?: string;
    };

/** Facts used to suggest an export filename; never a filesystem path. */
export interface ExportNameInput {
  /** Workspace leaf used in the suggested stem. */
  workspaceName: string;
  /** Whether this export is all chats or a named selection. */
  selection: ExportNameSelection;
  /** Clock used for the timestamp segment; tests inject a fixed date. */
  now?: Date;
}

/** Filename suffix written next to the suggested export stem. */
const SUFFIX = '.cursor-chat.json';
/** Windows device names that must not become a filename leaf. */
const RESERVED = /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/iu;

/** Truncate without splitting a Unicode code point or exceeding a UTF-8 byte budget. */
function truncateUtf8(value: string, maxBytes: number): string {
  let result = '';
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > maxBytes) break;
    result += character;
    bytes += size;
  }
  return result;
}

/** Build a readable filename component, never a path; preserve Unicode and case. */
export function cleanFilenamePart(
  value: string,
  fallback: string,
  maxBytes = 72,
): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 16) {
    throw new RangeError('Invalid filename budget');
  }
  let cleaned = value
    .normalize('NFC')
    .replace(
      // Windows reserved characters, ASCII controls, and bidi marks.
      // eslint-disable-next-line no-control-regex -- filename sanitizer
      /[<>:"/\\|?*\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/gu,
      '-',
    )
    .replace(/\s+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^[.\s-]+|[.\s-]+$/gu, '');
  if (!cleaned) cleaned = fallback;
  if (RESERVED.test(cleaned)) cleaned = `_${cleaned}`;
  if (Buffer.byteLength(cleaned, 'utf8') > maxBytes) {
    const digest = createHash('sha256')
      .update(cleaned)
      .digest('hex')
      .slice(0, 8);
    cleaned = `${truncateUtf8(cleaned, maxBytes - 9).replace(/[.\s-]+$/gu, '')}-${digest}`;
  }
  return cleaned;
}

/** Human workspace leaf from identity URI path, not a local fsPath. */
export function workspaceNameFromIdentity(
  kind: string | undefined,
  uriPath: string | undefined,
): string {
  const leaf = (uriPath || '').split('/').filter(Boolean).at(-1);
  const name = leaf || 'workspace';
  return kind === 'workspace' ? name.replace(/\.code-workspace$/i, '') : name;
}

/** Filename selection from the chats that will actually be written. */
export function selectionForFilename(
  mode: 'all' | 'selected',
  chats: Array<{ name?: string }>,
): ExportNameInput['selection'] {
  if (!Number.isSafeInteger(chats.length) || chats.length < 1) {
    throw new RangeError('An export must contain at least one selected chat');
  }
  if (mode === 'all') return { kind: 'all', count: chats.length };
  if (chats.length === 1) {
    return {
      kind: 'selected',
      count: 1,
      chatTitle: chats[0].name || 'chat',
    };
  }
  return { kind: 'selected', count: chats.length };
}

/** Suggest an editable export name from the actual selection, using UTC. */
export function suggestExportFilename(input: ExportNameInput): string {
  const { selection } = input;
  if (!Number.isSafeInteger(selection.count) || selection.count < 1) {
    throw new RangeError('An export must contain at least one selected chat');
  }
  const date = input.now ?? new Date();
  if (!Number.isFinite(date.getTime())) throw new RangeError('Invalid date');
  const workspace = cleanFilenamePart(input.workspaceName, 'workspace');
  const scope =
    selection.kind === 'all'
      ? 'all-chats'
      : selection.count === 1
        ? cleanFilenamePart(selection.chatTitle ?? '', 'chat')
        : `${selection.count}-chats`;
  const stamp = date.toISOString().replace(/[-:.]/g, '');
  return `${workspace}--${scope}--${stamp}${SUFFIX}`;
}
