import { decodeCanonicalBase64, sha256Hex } from './resource-bytes';
import type { CanvasResource } from './types';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import * as db from './db';
import { connOf } from './transfer-context';
import type { TransferContext, WorkspaceEntry } from './types';
import { readArtifactSource, type ArtifactSource } from './artifact-source';
import { VISUALIZATION_FILENAME } from './artifact-support';
import { provisionWindowsVisualizationScope } from './windows-store-security';

/** Cursor 3.29.9's visualization HTML byte limit. */
export const MAX_VISUALIZATION_BYTES = 1_572_864;

/** Renderer-compatible basename; never a path or URI. */
export function isVisualizationFilename(filename: string): boolean {
  return VISUALIZATION_FILENAME.test(filename);
}

/**
 * Read opaque HTML from an already resolved agent-store files directory.
 * Scope selection belongs to the caller: do not search other agents or fetch
 * missing remote content. Bytes are neither parsed nor executed.
 */
export async function readVisualizationFile(
  resolvedScopeFiles: string,
  filename: string,
  signal?: AbortSignal,
): Promise<ArtifactSource | null> {
  if (!path.isAbsolute(resolvedScopeFiles)) {
    throw new Error('Visualization agent-store scope must be absolute.');
  }

  await assertVisualizationScope(resolvedScopeFiles);

  return readArtifactSource({
    root: path.join(resolvedScopeFiles, 'visualizations'),
    filename,
    isBasename: isVisualizationFilename,
    kind: 'Visualization HTML',
    maxBytes: MAX_VISUALIZATION_BYTES,
    signal,
  });
}

/** Resolve only the owning composer scope; never search unrelated stores. */
export async function visualizationScopeFiles(
  ctx: TransferContext,
  workspace: WorkspaceEntry,
  agentId: string,
): Promise<string> {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(agentId)) {
    throw new Error('Invalid visualization owner.');
  }

  const resolved = ctx.resolveVisualizationScopeFiles
    ? await ctx.resolveVisualizationScopeFiles({ agentId, workspace })
    : path.join(localAgentStoreBase(), 'cursor_agent_stores', agentId, 'files');

  if (!path.isAbsolute(resolved))
    throw new Error('Visualization scope must be absolute.');

  await assertVisualizationScope(resolved);

  return resolved;
}

/** Import only: Cursor's EB handout creates files before sync admission.
 * Never manufacture/copy .sync/root-id, owner.json, mount.json or sync indexes:
 * those are fenced identities owned by Cursor, not portable chat resources.
 */
export async function provisionVisualizationScope(
  ctx: TransferContext,
  workspace: WorkspaceEntry,
  agentId: string,
): Promise<string> {
  const scope = await visualizationScopeFiles(ctx, workspace, agentId);

  const base = ctx.resolveVisualizationScopeFiles
    ? scope
    : localAgentStoreBase();

  if (process.platform === 'win32') {
    await provisionWindowsVisualizationScope(scope, base);

    return scope;
  }

  // Match Cursor V/Q: reject writable non-sticky ancestors and foreign roots.
  let current = path.parse(base).root;

  for (const part of base
    .slice(current.length)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, part);

    try {
      const stat = await fs.lstat(current);

      if ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0)
        throw new Error('Insecure writable agent-store ancestor.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  const uid = process.geteuid?.();

  if (uid === undefined)
    throw new Error('Agent-store current uid unavailable.');
  const created: Array<{ directory: string; dev: number; ino: number }> = [];

  try {
    current = path.parse(scope).root;

    for (const part of scope
      .slice(current.length)
      .split(path.sep)
      .filter(Boolean)) {
      current = path.join(current, part);
      let made = false;

      try {
        await fs.mkdir(current, { mode: 0o700 });
        made = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }

      const entry = await fs.lstat(current);

      if (made)
        created.push({ directory: current, dev: entry.dev, ino: entry.ino });
      if (!entry.isDirectory() || entry.isSymbolicLink())
        throw new Error('Unsafe visualization scope directory.');
      if (
        (current === base || current.startsWith(`${base}${path.sep}`)) &&
        (entry.uid !== uid || (entry.mode & 0o077) !== 0)
      )
        throw new Error(
          'Agent-store root and scope must be owned by the current user and private (0700).',
        );
    }
  } catch (error) {
    // Only undo empty directories this attempt created, with unchanged identity.
    // Never recursively delete state that Cursor or another import may now own.
    for (const item of created.reverse()) {
      try {
        const entry = await fs.lstat(item.directory);

        if (
          entry.dev === item.dev &&
          entry.ino === item.ino &&
          !entry.isSymbolicLink()
        )
          await fs.rmdir(item.directory);
      } catch {
        /* Nonempty/replaced directories are intentionally retained. */
      }
    }

    throw error;
  }

  return scope;
}

/** Verified persistent platform layout only; never mount, sync, chmod or probe temp fallbacks. */
export function localAgentStoreBase(): string {
  const override = process.env.CURSOR_AGENT_STORE_DIR;

  if (override) {
    if (!path.isAbsolute(override))
      throw new Error('Agent store override must be absolute.');

    return override;
  }

  if (process.platform === 'linux') {
    const state = process.env.XDG_STATE_HOME?.trim();

    return path.join(
      state && path.isAbsolute(state)
        ? state
        : path.join(os.homedir(), '.local', 'state'),
      'cursor',
      'agent-stores',
    );
  }

  if (process.platform === 'darwin')
    return path.join(
      os.homedir(),
      'Library',
      'Application Support',
      'Cursor',
      'AgentStores',
    );
  if (process.platform === 'win32')
    return path.join(
      process.env.LOCALAPPDATA?.trim() &&
        path.isAbsolute(process.env.LOCALAPPDATA.trim())
        ? process.env.LOCALAPPDATA.trim()
        : path.join(os.homedir(), 'AppData', 'Local'),
      'Cursor',
      'AgentStores',
    );

  throw new Error('Unsupported visualization agent-store platform.');
}

/** Reject symlinks in every existing scope ancestor, including store ownership directories. */
export async function assertVisualizationScope(scope: string): Promise<void> {
  let current = path.parse(scope).root;

  for (const part of scope
    .slice(current.length)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, part);

    try {
      const entry = await fs.lstat(current);

      if (!entry.isDirectory() || entry.isSymbolicLink())
        throw new Error('Unsafe visualization scope directory.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

/** FV0/sat: current owner, side-chat parent, nearest project ancestor only. */
export async function readChatVisualization(
  ctx: TransferContext,
  workspace: WorkspaceEntry,
  agentId: string,
  filename: string,
): Promise<ArtifactSource | null> {
  const ids = [agentId];
  const seen = new Set<string>();
  let id: string | undefined = agentId;
  let first = true;

  while (id && !seen.has(id) && seen.size < 100) {
    seen.add(id);

    const text = await db.readKvText(
      connOf(ctx, workspace.globalDbPath, true),
      `composerData:${id}`,
    );

    if (!text) break;

    const composer = JSON.parse(text) as {
      isProject?: boolean;
      subagentInfo?: { parentComposerId?: string; subagentTypeName?: string };
    };

    if (!first && composer.isProject === true) {
      ids.push(id);
      break;
    }

    const parent = composer.subagentInfo?.parentComposerId;

    if (
      first &&
      composer.subagentInfo?.subagentTypeName === 'side-chat' &&
      parent
    )
      ids.push(parent);
    first = false;
    id = parent;
  }

  for (const owner of new Set(ids)) {
    const scope = await visualizationScopeFiles(ctx, workspace, owner);

    await assertVisualizationScope(scope);
    const found = await readVisualizationFile(scope, filename, ctx.signal);

    if (found) return found;
  }

  return null;
}

/** Validate a portable inert visualization envelope. */
export function decodeVisualization(row: CanvasResource): Buffer {
  if (
    !isVisualizationFilename(row.filename) ||
    row.byteLength > MAX_VISUALIZATION_BYTES
  )
    throw new Error('Invalid visualization envelope.');
  const bytes = decodeCanonicalBase64(row.base64, row.byteLength);

  if (
    bytes.length !== row.byteLength ||
    sha256Hex(bytes) !== row.sha256 ||
    bytes.length > MAX_VISUALIZATION_BYTES
  )
    throw new Error('Invalid visualization checksum or size.');

  return bytes;
}
