import { fileUriMetadata } from './file-uri';
import type { ComposerHeader, WorkspaceIdentity } from './types';
import { TransferError } from './types';

/** Compare-and-swap retries when Cursor writes headers during import. */
export const CAS_ATTEMPTS = 5;

/** Append headers that are not already in `current`. A non-array is refused. */
export function mergeComposerList(
  current: unknown,
  extra: ComposerHeader[],
): ComposerHeader[] {
  if (current !== undefined && !Array.isArray(current)) {
    throw new TransferError('composer list is not an array.');
  }

  const list = Array.isArray(current) ? (current as ComposerHeader[]) : [];

  const have = new Set(
    list
      .map((composer) => composer && composer.composerId)
      .filter((id): id is string => Boolean(id)),
  );

  return list.concat(
    extra.filter(
      (composer) =>
        composer && composer.composerId && !have.has(composer.composerId),
    ),
  );
}

/** Parse stored ItemTable JSON, or an empty object when the key is missing. */
export function parseItemObject(raw: string | null): Record<string, unknown> {
  if (raw === null) return {};
  if (raw === '') throw new TransferError('ItemTable value is empty.');

  const parsed: unknown = JSON.parse(raw);

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TransferError('ItemTable value is not a JSON object.');
  }

  return parsed as Record<string, unknown>;
}

/** Bind a cloned header to the target workspace storage id and URI. */
export function bindWorkspace(
  header: ComposerHeader,
  storageId: string,
  identity: WorkspaceIdentity | undefined,
): ComposerHeader {
  const copy: ComposerHeader = { ...header };
  const uri = identity?.uri;

  copy.workspaceIdentifier = { id: storageId };

  if (uri) {
    copy.workspaceIdentifier.uri = {
      $mid: 1,
      scheme: uri.scheme,
      authority: uri.authority || '',
      path: uri.path,
      query: uri.query || '',
      fragment: uri.fragment || '',
    };

    if (uri.scheme === 'file') {
      Object.assign(copy.workspaceIdentifier.uri, fileUriMetadata(uri));
    }
  }

  return copy;
}
