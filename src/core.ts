import type {
  ComposerHeader,
  Json,
  UriParts,
  WorkspaceIdentity,
  WorkspaceKind,
} from './types';

/** Normalize a URI-like object into identity components. */
function uriPartsFrom(uri: {
  scheme: string;
  authority?: string;
  path: string;
  query?: string;
  fragment?: string;
}): UriParts {
  return {
    scheme: uri.scheme,
    authority: uri.authority || '',
    path: uri.path,
    query: uri.query || '',
    fragment: uri.fragment || '',
  };
}

/** Select chats by id. `undefined` means all; `[]` means none. */
export function selectChats(
  chats: ComposerHeader[],
  selectedIds?: string[],
): ComposerHeader[] {
  if (selectedIds === undefined) return chats;
  if (!Array.isArray(selectedIds))
    throw new TypeError('selectedIds must be an array');
  const selected = new Set(selectedIds);

  return chats.filter((chat) => selected.has(chat.composerId));
}

/** Stable workspace identity key: kind + scheme/authority/path/query/fragment. */
export function workspaceKey(kind: WorkspaceKind, uri: UriParts): string {
  if (!['folder', 'workspace'].includes(kind))
    throw new TypeError('Invalid workspace kind');

  if (!uri || typeof uri.scheme !== 'string' || typeof uri.path !== 'string') {
    throw new TypeError('Pass a parsed URI, not fsPath');
  }

  return JSON.stringify([
    kind,
    uri.scheme,
    uri.authority || '',
    uri.path,
    uri.query || '',
    uri.fragment || '',
  ]);
}

/** Percent-decode `%XX` runs once, matching vscode.Uri.parse. */
function percentDecodeOnce(value: string): string {
  return value.replace(/(%[0-9A-Fa-f]{2})+/g, (seq) => {
    try {
      return decodeURIComponent(seq);
    } catch {
      return seq;
    }
  });
}

/** Parse a URI string; decode authority and path once without lowercasing. */
export function uriFromString(value: string): UriParts {
  if (typeof value !== 'string' || !value)
    throw new TypeError('Expected URI string');
  const u = new URL(value);

  return {
    scheme: u.protocol.replace(/:$/, ''),
    authority: percentDecodeOnce(u.host || ''),
    path: percentDecodeOnce(u.pathname || ''),
    query: u.search.startsWith('?') ? u.search.slice(1) : u.search || '',
    fragment: u.hash.startsWith('#') ? u.hash.slice(1) : u.hash || '',
  };
}

/** Read workspace identity from Cursor `workspace.json` (`workspace` wins over `folder`). */
export function identityFromWorkspaceJson(meta: unknown): WorkspaceIdentity {
  if (!meta || typeof meta !== 'object') {
    throw new Error('Workspace metadata has neither folder nor workspace URI');
  }

  const rec = meta as Record<string, unknown>;

  if (typeof rec.workspace === 'string') {
    return { kind: 'workspace', uri: uriFromString(rec.workspace) };
  }

  if (typeof rec.folder === 'string') {
    return { kind: 'folder', uri: uriFromString(rec.folder) };
  }

  throw new Error('Workspace metadata has neither folder nor workspace URI');
}

/** Current host identity: `.code-workspace` file first, else a single folder. */
export function currentIdentity(
  workspaceFile?:
    | {
        scheme: string;
        authority?: string;
        path: string;
        query?: string;
        fragment?: string;
      }
    | undefined,
  workspaceFolders?:
    | ReadonlyArray<{
        uri: {
          scheme: string;
          authority?: string;
          path: string;
          query?: string;
          fragment?: string;
        };
      }>
    | undefined,
): WorkspaceIdentity | undefined {
  if (workspaceFile) {
    return { kind: 'workspace', uri: uriPartsFrom(workspaceFile) };
  }

  const folders = workspaceFolders || [];

  if (folders.length === 1) {
    return { kind: 'folder', uri: uriPartsFrom(folders[0].uri) };
  }

  return undefined;
}

/** Inclusive/exclusive key bounds for `bubbleId:<uuid>:` rows. */
export function bubbleRange(composerId: string): {
  lower: string;
  upper: string;
} {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      composerId,
    )
  ) {
    throw new TypeError(
      'Unsupported composer ID: validate other observed formats separately',
    );
  }

  const lower = `bubbleId:${composerId}:`;

  return { lower, upper: `bubbleId:${composerId};` };
}

/** Encode a UTF-8 string as a SQLite text literal without quoting. */
export function sqlText(value: string): string {
  if (typeof value !== 'string') throw new TypeError('Expected a string');

  return `CAST(X'${Buffer.from(value, 'utf8').toString('hex')}' AS TEXT)`;
}

/** Rewrite string values at JSON Pointers using `idMap`; never substring-replace text. */
export function rewriteExactPaths(
  value: unknown,
  pointers: string[],
  idMap: Map<string, string>,
): unknown {
  const copy = JSON.parse(JSON.stringify(value)) as Json;

  for (const pointer of pointers) {
    if (!pointer.startsWith('/'))
      throw new TypeError('Expected a JSON Pointer');

    const parts = pointer
      .slice(1)
      .split('/')
      .map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));

    if (
      parts.some((p) => ['__proto__', 'prototype', 'constructor'].includes(p))
    ) {
      throw new TypeError('Forbidden property');
    }

    let parent: unknown = copy;

    for (const part of parts.slice(0, -1)) {
      if (
        parent === null ||
        typeof parent !== 'object' ||
        !Object.hasOwn(parent, part)
      ) {
        parent = undefined;
        break;
      }

      parent = (parent as Record<string, unknown>)[part];
    }

    const last = parts.at(-1);

    if (
      last &&
      parent !== null &&
      typeof parent === 'object' &&
      Object.hasOwn(parent, last)
    ) {
      const rec = parent as Record<string, unknown>;
      const old = rec[last];

      if (typeof old === 'string') {
        const mapped = idMap.get(old);

        if (mapped !== undefined) rec[last] = mapped;
      }
    }
  }

  return copy;
}

/** Rename object keys that appear in `idMap`. */
export function rewriteObjectKeys(
  obj: unknown,
  idMap: Map<string, string>,
): unknown {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  const out: Record<string, unknown> = {};

  for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
    const next = idMap.get(key) ?? key;

    out[next] = val;
  }

  return out;
}

/** Truncate a finite number; otherwise return `fallback`. */
export function finiteInt(
  value: unknown,
  fallback: number | null = null,
): number | null {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);

  if (!Number.isFinite(n)) return fallback;

  return Math.trunc(n);
}
