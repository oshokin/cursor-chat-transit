import type { UriParts } from './types';

/** Format local filesystem metadata without losing UNC hosts or URI escaping. */
export function fileUriMetadata(
  /** URI string or parts. */
  uri: UriParts,
  /** Operating system id used for paths. */
  platform: NodeJS.Platform = process.platform,
): {
  /** `file://` URI with encoded path segments. */
  external: string;
  /** Native path for this platform, including a UNC host. */
  fsPath: string;
} {
  if (uri.scheme !== 'file') throw new TypeError('Expected a file URI');
  const encodedPath = uri.path.split('/').map(encodeURIComponent).join('/');
  const external = `file://${uri.authority}${encodedPath}${uri.query ? `?${uri.query}` : ''}${uri.fragment ? `#${uri.fragment}` : ''}`;

  return { external, fsPath: nativeFsPath(uri, platform) };
}

/** Drive letters and UNC shares use the platform separator. Other file paths stay URI paths. */
function nativeFsPath(
  /** URI string or parts. */
  uri: UriParts,
  /** Operating system id used for paths. */
  platform: NodeJS.Platform,
): string {
  if (platform !== 'win32')
    return (uri.authority ? `//${uri.authority}` : '') + uri.path;
  if (uri.authority)
    return `\\\\${uri.authority}${uri.path.replace(/\//g, '\\')}`;
  const drive = /^\/([A-Za-z]:)(.*)$/.exec(uri.path);

  if (!drive) return uri.path;

  return `${drive[1]}${drive[2].replace(/\//g, '\\')}`;
}
