import { workspaceKey } from './core';
import { headerWorkspaceKey, type HeaderSource } from './db-headers';
import type { ComposerHeader, WorkspaceEntry } from './types';

/** Index one immutable global-header snapshot; explicit storage IDs outrank URI fallback. */
export function indexGlobalHeaders(
  sources: HeaderSource[],
): (workspace: WorkspaceEntry) => HeaderSource[] {
  const indexed = sources.map((source) => {
    const byStorage = new Map<
      string,
      /** Position. */
      {
        /** Index of this header in the source list. */
        position: number;
        /** Composer header at that index. */
        header: ComposerHeader;
      }[]
    >();

    const byUri = new Map<
      string,
      /** Position. */
      {
        /** Index of this header in the source list. */
        position: number;
        /** Composer header at that index. */
        header: ComposerHeader;
      }[]
    >();

    source.records.forEach(
      (
        header,
        /** Zero-based position in the source list. */
        position,
      ) => {
        const id = header.workspaceIdentifier?.id;
        const explicit = typeof id === 'string' && id.length > 0;

        const key = explicit
          ? id
          : header.workspaceIdentifier &&
            headerWorkspaceKey(header.workspaceIdentifier);

        if (!key) return;
        const map = explicit ? byStorage : byUri;
        const rows = map.get(key) || [];

        rows.push({ position, header });
        map.set(key, rows);
      },
    );

    return { source: source.source, byStorage, byUri };
  });

  return (workspace) => {
    const uri =
      workspace.identity &&
      workspaceKey(workspace.identity.kind, workspace.identity.uri);

    return indexed.map(
      (
        /** Indexed header source for one workspace. */
        { source, byStorage, byUri },
      ) => ({
        source,
        // Preserve source order: duplicate headers at the same precedence are first-wins.
        records: [
          ...(byStorage.get(workspace.storageId) || []),
          ...(uri ? byUri.get(uri) || [] : []),
        ]
          .sort((a, b) => a.position - b.position)
          .map((row) => row.header),
      }),
    );
  };
}
