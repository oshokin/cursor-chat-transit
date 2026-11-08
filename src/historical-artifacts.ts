import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readArtifactSource, type ArtifactSource } from './artifact-source';
import { assertVisualizationScope } from './visualizations';
import { writeFileNoClobber } from './resource-files';
import { sha256Hex } from './resource-bytes';
import { canvasesDirectoryForWorkspace } from './canvases';
import type { TransferContext, WorkspaceEntry } from './types';

/** Project artifact root, shared by transcripts and terminal snapshots. */
export function historicalProjectRoot(
  ctx: TransferContext,
  workspace: WorkspaceEntry,
): string | null {
  if (ctx.projectArtifactsDir) return ctx.projectArtifactsDir;
  const canvases = canvasesDirectoryForWorkspace(workspace);

  return canvases ? path.dirname(canvases) : null;
}

/** Portable metadata retained in the resource id, not an executable source path. */
export interface HistoricalMetadata {
  layout?: TranscriptLayout;
  extension?: 'jsonl' | 'txt';
  parent?: string;
  terminalName?: string;
  sourceRoot?: string;
  sourceFile?: string;
}

/** Canonical metadata identity survives the SQLite resource index unchanged. */
export function historicalResourceId(metadata: HistoricalMetadata): string {
  return Buffer.from(JSON.stringify(metadata)).toString('base64url');
}

/** Validate untrusted metadata before any path construction. */
export function parseHistoricalResourceId(
  id: string,
  kind: string,
): HistoricalMetadata {
  if (!/^[A-Za-z0-9_-]{1,16000}$/.test(id))
    throw new Error('Invalid historical resource identity.');

  const metadata = JSON.parse(
    Buffer.from(id, 'base64url').toString('utf8'),
  ) as HistoricalMetadata;

  if (
    !metadata ||
    typeof metadata !== 'object' ||
    historicalResourceId(metadata) !== id
  )
    throw new Error('Invalid historical resource metadata.');
  if (kind === 'transcript') {
    if (metadata.sourceRoot !== undefined)
      assertAbsoluteRoot(metadata.sourceRoot);
    if (
      !['nested', 'canonical', 'legacy'].includes(String(metadata.layout)) ||
      !['jsonl', 'txt'].includes(String(metadata.extension)) ||
      (metadata.parent !== undefined &&
        (typeof metadata.parent !== 'string' || !metadata.parent))
    )
      throw new Error('Invalid transcript resource metadata.');
    if (metadata.layout === 'nested' && !metadata.parent)
      throw new Error('Missing transcript parent.');
  } else if (kind === 'terminal-history') {
    if (
      typeof metadata.terminalName !== 'string' ||
      !TERMINAL_NAME.test(metadata.terminalName) ||
      typeof metadata.sourceRoot !== 'string'
    )
      throw new Error('Invalid terminal resource metadata.');
    assertAbsoluteRoot(metadata.sourceRoot);
    if (
      metadata.sourceFile !== undefined &&
      (typeof metadata.sourceFile !== 'string' ||
        !terminalReferencePath(metadata.sourceFile, metadata.sourceRoot))
    )
      throw new Error('Invalid terminal source reference.');
  } else throw new Error('Invalid historical resource class.');

  return metadata;
}

/** Destination derived solely from validated metadata and assigned database ownership. */
export function historicalDestination(
  root: string,
  kind: string,
  id: string,
  owner: string,
  map: ReadonlyMap<string, string> = new Map(),
): string {
  assertAbsoluteRoot(root);
  const metadata = parseHistoricalResourceId(id, kind);

  return kind === 'transcript'
    ? path.join(
        root,
        'agent-transcripts',
        transcriptRelativePath(
          owner,
          metadata.layout!,
          metadata.extension!,
          metadata.parent
            ? map.get(metadata.parent) || metadata.parent
            : undefined,
        ),
      )
    : path.join(
        root,
        'chat-transit-history',
        encodeTranscriptId(owner),
        'terminal-snapshots',
        metadata.terminalName!,
      );
}

/** Cursor ELn. Encoding is not injective: callers must check ownership collisions. */
export function encodeTranscriptId(id: string): string {
  if (!id || id.includes('\0')) throw new Error('Invalid transcript owner.');

  const encoded = encodeURIComponent(id).replace(/%/g, '_').slice(0, 200);

  if (encoded === '.' || encoded === '..')
    throw new Error('Unsafe transcript owner.');

  return encoded;
}

/** Verified Cursor transcript layouts. */
export type TranscriptLayout = 'canonical' | 'nested' | 'legacy';
/** Opaque snapshot and its database-established ownership. */
export interface HistoricalArtifact {
  kind: 'transcript' | 'terminal-history';
  owner: string;
  parent?: string;
  layout?: TranscriptLayout;
  extension?: 'jsonl' | 'txt';
  /** Terminal source basename, not a process identity at the destination. */
  terminalName?: string;
  sourceFile?: string;
  source: ArtifactSource;
}

/** Hard bound per historical file. */
export const MAX_HISTORICAL_ARTIFACT_BYTES = 16 * 1024 * 1024;

/** Never derive ownership from JSONL contents or arbitrary directory entries. */
export function transcriptRelativePath(
  owner: string,
  layout: TranscriptLayout,
  extension: 'jsonl' | 'txt',
  parent?: string,
): string {
  if (
    !['canonical', 'nested', 'legacy'].includes(layout) ||
    !['jsonl', 'txt'].includes(extension)
  )
    throw new Error('Invalid transcript layout or extension.');
  const id = encodeTranscriptId(owner);

  if (layout === 'legacy') return `${id}.${extension}`;

  if (layout === 'nested') {
    if (!parent) throw new Error('Nested transcript requires its DB parent.');

    return path.join(
      encodeTranscriptId(parent),
      'subagents',
      `${id}.${extension}`,
    );
  }

  return path.join(id, `${id}.${extension}`);
}

/** Reject encoding/truncation aliases even when the corresponding files are absent. */
export function assertDistinctTranscriptOwners(ids: Iterable<string>): void {
  const owners = new Map<string, string>();

  for (const id of ids) {
    const encoded = encodeTranscriptId(id);
    const previous = owners.get(encoded);

    if (previous !== undefined && previous !== id)
      throw new Error('Transcript owner encoding collision.');
    owners.set(encoded, id);
  }
}

/** Snapshot all supported variants, including TXT derivatives, without directory scanning. */
export async function readOwnedTranscripts(opts: {
  projectRoot: string;
  owner: string;
  /** Only composerData.subagentInfo.parentComposerId is authoritative. */
  parent?: string;
  signal?: AbortSignal;
}): Promise<HistoricalArtifact[]> {
  assertAbsoluteRoot(opts.projectRoot);

  assertDistinctTranscriptOwners([
    opts.owner,
    ...(opts.parent ? [opts.parent] : []),
  ]);

  const result: HistoricalArtifact[] = [];

  const layouts: TranscriptLayout[] = opts.parent
    ? ['nested', 'canonical', 'legacy']
    : ['canonical', 'legacy'];

  for (const extension of ['jsonl', 'txt'] as const) {
    for (const layout of layouts) {
      opts.signal?.throwIfAborted();

      const relative = transcriptRelativePath(
        opts.owner,
        layout,
        extension,
        opts.parent,
      );

      const full = path.join(opts.projectRoot, 'agent-transcripts', relative);

      await assertVisualizationScope(path.dirname(full));

      const source = await readArtifactSource({
        root: path.dirname(full),
        filename: path.basename(full),
        isBasename: (name) => name === path.basename(relative),
        kind: 'External transcript',
        maxBytes: MAX_HISTORICAL_ARTIFACT_BYTES,
        signal: opts.signal,
      });

      if (source)
        result.push({
          kind: 'transcript',
          owner: opts.owner,
          parent: opts.parent,
          layout,
          extension,
          source,
        });
    }
  }

  return result;
}

/** Explicit terminal references and unsupported live-mention diagnostics. */
export interface TerminalReferences {
  /** Exact explicit source references; never inferred from plain prose. */
  files: Set<string>;
  unsupportedLiveMentions: number;
}

const TERMINAL_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}\.txt$/;

/** Recognize only exact paths beneath this project's terminal snapshot directory. */
export function terminalReferencePath(
  value: string,
  projectRoot: string,
): {
  filename: string;
  suffix: string;
  uri: boolean;
} | null {
  if (value.length > 16_384 || value.includes('\0')) return null;
  const match = /^(.*?)(:\d+(?::\d+)?|#L\d+(?:-L?\d+)?)?$/.exec(value);

  if (!match) return null;
  const base = match[1]!;
  let source = base;
  const uri = source.startsWith('file:');

  try {
    if (uri) source = fileURLToPath(source);
  } catch {
    return null;
  }

  if (!path.isAbsolute(source) || source !== path.normalize(source))
    return null;
  const relative = path.relative(projectRoot, source).split(path.sep);

  const historical =
    relative.length === 4 &&
    relative[0] === 'chat-transit-history' &&
    /^[A-Za-z0-9_!~*'().-]{1,200}$/.test(relative[1]!) &&
    relative[2] === 'terminal-snapshots';

  if (
    path.dirname(source) !== path.join(projectRoot, 'terminals') &&
    !historical
  )
    return null;
  const filename = path.basename(source);

  return TERMINAL_NAME.test(filename)
    ? { filename, suffix: match[2] || '', uri }
    : null;
}

/** Bounded structural traversal; plain message text and arbitrary path fields are ignored. */
export function terminalReferencesFromJson(
  value: unknown,
  projectRoot: string,
): TerminalReferences {
  assertAbsoluteRoot(projectRoot);

  const result: TerminalReferences = {
    files: new Set(),
    unsupportedLiveMentions: 0,
  };

  const queue: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let visited = 0;

  const add = (raw: unknown): void => {
    if (typeof raw !== 'string') return;

    if (raw.startsWith('vscode-terminal:')) {
      result.unsupportedLiveMentions++;

      return;
    }

    if (terminalReferencePath(raw, projectRoot)) result.files.add(raw);
  };

  while (queue.length) {
    if (++visited > 100_000)
      throw new Error('Terminal reference property budget exceeded.');
    const item = queue.pop()!;

    if (item.depth > 40)
      throw new Error('Terminal reference nesting limit exceeded.');
    if (!item.value || typeof item.value !== 'object') continue;

    if (Array.isArray(item.value)) {
      for (const value of item.value)
        queue.push({ value, depth: item.depth + 1 });
      continue;
    }

    const rec = item.value as Record<string, unknown>;

    for (const container of ['context', 'mentions']) {
      const parent = rec[container];

      if (parent && typeof parent === 'object' && !Array.isArray(parent)) {
        const rows = (parent as Record<string, unknown>).terminalFiles;

        if (Array.isArray(rows))
          for (const row of rows) {
            if (typeof row === 'string') add(row);
            else if (row && typeof row === 'object') {
              const entry = row as Record<string, unknown>;

              for (const key of ['uri', 'text', 'terminalFilePath'])
                add(entry[key]);
            }
          }
      }
    }

    if (rec.case === 'terminalFile') {
      const entry =
        rec.value && typeof rec.value === 'object'
          ? (rec.value as Record<string, unknown>)
          : rec;

      for (const key of ['uri', 'text', 'terminalFilePath']) add(entry[key]);
    }

    add(rec.terminalInstancePath);

    if (rec.terminalsFolder === path.join(projectRoot, 'terminals')) {
      for (const key of ['backgroundShellId', 'shellId']) {
        const id = rec[key];

        if (
          (typeof id === 'string' || typeof id === 'number') &&
          TERMINAL_NAME.test(`${id}.txt`)
        )
          add(path.join(projectRoot, 'terminals', `${id}.txt`));
      }
    }

    for (const nested of Object.values(rec))
      queue.push({ value: nested, depth: item.depth + 1 });
  }

  return result;
}

/** Read only the terminal snapshots explicitly referenced by this chat. */
export async function readReferencedTerminalHistory(opts: {
  projectRoot: string;
  owner: string;
  references: Iterable<string>;
  signal?: AbortSignal;
}): Promise<{ artifacts: HistoricalArtifact[]; missing: string[] }> {
  assertAbsoluteRoot(opts.projectRoot);
  const artifacts: HistoricalArtifact[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();

  await assertVisualizationScope(path.join(opts.projectRoot, 'terminals'));

  for (const reference of opts.references) {
    opts.signal?.throwIfAborted();
    const parsed = terminalReferencePath(reference, opts.projectRoot);

    if (!parsed) throw new Error('Unsafe terminal artifact reference.');
    if (seen.has(parsed.filename)) continue;
    seen.add(parsed.filename);

    const raw = reference.slice(
      0,
      reference.length - parsed.suffix.length || undefined,
    );

    const sourceFile = parsed.uri ? fileURLToPath(raw) : raw;

    await assertVisualizationScope(path.dirname(sourceFile));

    const source = await readArtifactSource({
      root: path.dirname(sourceFile),
      filename: parsed.filename,
      isBasename: (name) => TERMINAL_NAME.test(name),
      kind: 'Historical terminal snapshot',
      maxBytes: MAX_HISTORICAL_ARTIFACT_BYTES,
      signal: opts.signal,
    });

    if (source)
      artifacts.push({
        kind: 'terminal-history',
        owner: opts.owner,
        terminalName: parsed.filename,
        sourceFile,
        source,
      });
    else missing.push(parsed.filename);
  }

  return { artifacts, missing };
}

/** Exact-byte, no-clobber install. No terminal, PTY, shell, or renderer is started. */
export async function installHistoricalArtifact(opts: {
  projectRoot: string;
  artifact: HistoricalArtifact;
  ownerMap: ReadonlyMap<string, string>;
  signal?: AbortSignal;
}): Promise<string> {
  assertAbsoluteRoot(opts.projectRoot);
  opts.signal?.throwIfAborted();
  assertDistinctTranscriptOwners(opts.ownerMap.values());
  const owner = opts.ownerMap.get(opts.artifact.owner);

  if (!owner) throw new Error('Artifact owner is not an imported chat.');
  const artifact = opts.artifact;

  if (
    !Buffer.isBuffer(artifact.source.bytes) ||
    artifact.source.bytes.length > MAX_HISTORICAL_ARTIFACT_BYTES ||
    artifact.source.byteLength !== artifact.source.bytes.length ||
    artifact.source.sha256 !== sha256Hex(artifact.source.bytes)
  )
    throw new Error('Invalid historical artifact bytes or checksum.');
  if (artifact.kind !== 'transcript' && artifact.kind !== 'terminal-history')
    throw new Error('Invalid historical artifact kind.');
  let destination: string;

  if (artifact.kind === 'transcript') {
    if (!artifact.layout || !artifact.extension)
      throw new Error('Incomplete transcript metadata.');

    const parent = artifact.parent
      ? opts.ownerMap.get(artifact.parent) || artifact.parent
      : undefined;

    destination = path.join(
      opts.projectRoot,
      'agent-transcripts',
      transcriptRelativePath(
        owner,
        artifact.layout,
        artifact.extension,
        parent,
      ),
    );
  } else {
    if (!artifact.terminalName || !TERMINAL_NAME.test(artifact.terminalName))
      throw new Error('Invalid historical terminal filename.');

    destination = path.join(
      opts.projectRoot,
      'chat-transit-history',
      encodeTranscriptId(owner),
      'terminal-snapshots',
      artifact.terminalName,
    );
  }

  await assertVisualizationScope(path.dirname(destination));
  opts.signal?.throwIfAborted();

  await writeFileNoClobber(
    path.dirname(destination),
    destination,
    artifact.source.bytes,
    'Historical artifact already exists with different bytes.',
  );

  return destination;
}

/** Rewrite only previously exported references, retaining URI form and line suffix. */
export function remapTerminalReference(
  reference: string,
  sourceProjectRoot: string,
  installed: ReadonlyMap<string, string>,
): string {
  const parsed = terminalReferencePath(reference, sourceProjectRoot);

  if (!parsed) return reference;
  const destination = installed.get(parsed.filename);

  if (!destination) return reference;

  return (
    (parsed.uri ? pathToFileURL(destination).href : destination) + parsed.suffix
  );
}

function assertAbsoluteRoot(root: string): void {
  if (
    !path.isAbsolute(root) ||
    root !== path.normalize(root) ||
    root.includes('\0')
  )
    throw new Error(
      'Historical artifact project root must be absolute and normalized.',
    );
}

/** Rewrite only schema-recognized terminal string fields, never arbitrary prose. */
export function rewriteHistoricalTerminalReferences(
  value: unknown,
  installed: ReadonlyMap<string, string>,
): unknown {
  const visit = (
    value: unknown,
    depth: number,
    terminalEntry = false,
  ): unknown => {
    if (depth > 40)
      throw new Error('Terminal reference nesting limit exceeded.');

    const rewrite = (raw: unknown): unknown => {
      if (typeof raw !== 'string') return raw;

      for (const [source, destination] of installed) {
        const directory = path.dirname(source);

        const root =
          path.basename(directory) === 'terminal-snapshots'
            ? path.dirname(path.dirname(path.dirname(directory)))
            : path.dirname(directory);

        const result = remapTerminalReference(
          raw,
          root,
          new Map([[path.basename(source), destination]]),
        );

        if (result !== raw) return result;
      }

      return raw;
    };

    if (Array.isArray(value))
      return value.map((entry) =>
        typeof entry === 'string' && terminalEntry
          ? rewrite(entry)
          : visit(entry, depth + 1, terminalEntry),
      );
    if (!value || typeof value !== 'object') return value;
    const rec = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    const entry = terminalEntry || rec.case === 'terminalFile';

    for (const [key, child] of Object.entries(rec)) {
      if (
        key === 'terminalInstancePath' ||
        (entry && ['uri', 'text', 'terminalFilePath'].includes(key))
      )
        result[key] = rewrite(child);
      else
        result[key] = visit(
          child,
          depth + 1,
          key === 'terminalFiles' || (entry && key === 'value'),
        );
    }

    return result;
  };

  return visit(value, 0);
}

/** Replace only exact exported transcript paths in structured URI/path fields. */
export function rewriteHistoricalTranscriptReferences(
  value: unknown,
  installed: ReadonlyMap<string, string>,
): unknown {
  const visit = (value: unknown, depth: number): unknown => {
    if (depth > 40)
      throw new Error('Transcript reference nesting limit exceeded.');
    if (Array.isArray(value))
      return value.map((item) => visit(item, depth + 1));
    if (!value || typeof value !== 'object') return value;
    const result: Record<string, unknown> = {};

    for (const [key, child] of Object.entries(value)) {
      if (
        typeof child === 'string' &&
        [
          'uri',
          'path',
          'fsPath',
          'external',
          'filePath',
          'targetFile',
          'relativeWorkspacePath',
        ].includes(key)
      ) {
        const match = /^(.*?)(:\d+(?::\d+)?|#L\d+(?:-L?\d+)?)?$/.exec(child)!;
        const uri = match[1]!.startsWith('file:');
        let source = match[1]!;

        try {
          if (uri) source = fileURLToPath(source);
        } catch {
          result[key] = child;
          continue;
        }

        const destination = installed.get(source);

        result[key] = destination
          ? (uri ? pathToFileURL(destination).href : destination) +
            (match[2] || '')
          : child;
      } else result[key] = visit(child, depth + 1);
    }

    return result;
  };

  return visit(value, 0);
}
