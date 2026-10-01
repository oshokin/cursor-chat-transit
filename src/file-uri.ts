import type { UriParts } from './types';

/** Format local filesystem metadata without losing UNC hosts or URI escaping. */
export function fileUriMetadata(
  uri: UriParts,
  platform: NodeJS.Platform = process.platform,
): {
  external: string;
  fsPath: string;
} {
  if (uri.scheme !== 'file') throw new TypeError('Expected a file URI');
  const encodedPath = uri.path.split('/').map(encodeURIComponent).join('/');
  const external = `file://${uri.authority}${encodedPath}${uri.query ? `?${uri.query}` : ''}${uri.fragment ? `#${uri.fragment}` : ''}`;

  const fsPath =
    platform === 'win32'
      ? (uri.authority
          ? `//${uri.authority}${uri.path}`
          : uri.path.replace(/^\/([A-Za-z]:)/, '$1')
        ).replace(/\//g, '\\')
      : (uri.authority ? `//${uri.authority}` : '') + uri.path;

  return { external, fsPath };
}
