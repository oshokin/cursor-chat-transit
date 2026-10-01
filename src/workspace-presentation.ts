import type { WorkspaceEntry } from './types';
import { fileUriMetadata } from './file-uri';

/** How the workspace URI is reached: local disk, SSH, container, WSL, or other. */
export type WorkspaceLocation =
  'local' | 'ssh' | 'container' | 'wsl' | 'remote' | 'unknown';
/** Picker group order: current workspace is applied separately in the pick list. */
export const LOCATION_ORDER: Record<WorkspaceLocation, number> = {
  local: 0,
  ssh: 1,
  container: 2,
  wsl: 3,
  remote: 4,
  unknown: 5,
};

/** Classification is independent of translated labels and SSH host names. */
export function workspaceLocation(entry: WorkspaceEntry): WorkspaceLocation {
  const uri = entry.identity?.uri;

  if (!uri) return 'unknown';
  if (uri.scheme === 'file') return 'local';
  if (uri.scheme !== 'vscode-remote') return 'remote';
  let authority = uri.authority;

  try {
    authority = decodeURIComponent(authority);
  } catch {
    /* unknown authority */
  }

  if (/^ssh-remote\+/i.test(authority)) return 'ssh';
  if (/^(dev-container|attached-container)\+/i.test(authority))
    return 'container';
  if (/^wsl\+/i.test(authority)) return 'wsl';

  return 'remote';
}

/** Labels only: decoded SSH names must never replace workspace identity. */
export function sshDisplayHost(authority: string): string | undefined {
  if (authority.length > 4096) return undefined;
  let decoded: string;

  try {
    decoded = decodeURIComponent(authority);
  } catch {
    return undefined;
  }

  if (!decoded.startsWith('ssh-remote+')) return undefined;
  const suffix = decoded.slice('ssh-remote+'.length);

  if (/^(?:[0-9a-f]{2})+$/i.test(suffix) && suffix.startsWith('7b')) {
    try {
      const data: unknown = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(
          Buffer.from(suffix, 'hex'),
        ),
      );

      if (!data || typeof data !== 'object' || Array.isArray(data))
        return undefined;
      const host = (data as { hostName?: unknown }).hostName;

      return typeof host === 'string' && /^[\w.@:[\]-]{1,160}$/.test(host)
        ? host
        : undefined;
    } catch {
      return undefined;
    }
  }

  return /^[\w.@:[\]-]{1,160}$/.test(suffix) ? suffix : undefined;
}

/** Compact user labels, with path and technical identity kept separate. */
export function workspacePresentation(entry: WorkspaceEntry): {
  /** Short workspace title. */
  name: string;
  /** Host or location line. */
  location: string;
  /** Path or extra identity line. */
  path: string;
  /** Location group used by the picker. */
  group: string;
} {
  const uri = entry.identity?.uri;

  if (!uri)
    return {
      name: 'Unidentified workspace',
      location: 'Workspace name unavailable',
      path: `Storage ID: ${entry.storageId}`,
      group: 'Unidentified',
    };
  const name = uri.path.split('/').filter(Boolean).at(-1) || 'Root folder';

  if (uri.scheme === 'file')
    return {
      name,
      location: 'This computer',
      path: fileUriMetadata(uri).fsPath,
      group: 'This computer',
    };
  const host = sshDisplayHost(uri.authority);

  const kind = {
    ssh: 'SSH',
    wsl: 'WSL',
    container: 'Container',
    remote: 'Remote',
    local: 'This computer',
    unknown: 'Unidentified',
  }[workspaceLocation(entry)];

  const location = host
    ? `${kind} · ${host}`
    : kind === 'SSH'
      ? 'SSH · Host unavailable'
      : kind;

  return {
    name,
    location,
    path: uri.path,
    group: kind === 'Container' ? 'Containers' : kind,
  };
}
