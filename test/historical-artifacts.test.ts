import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  assertDistinctTranscriptOwners,
  encodeTranscriptId,
  installHistoricalArtifact,
  MAX_HISTORICAL_ARTIFACT_BYTES,
  readOwnedTranscripts,
  readReferencedTerminalHistory,
  remapTerminalReference,
  terminalReferencesFromJson,
  transcriptRelativePath,
} from '../src/historical-artifacts';

async function fixture(t: {
  after(fn: () => Promise<void>): void;
}): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'transit-history-'));

  t.after(() => fs.rm(root, { recursive: true, force: true }));

  return root;
}

async function put(
  root: string,
  relative: string,
  bytes: Buffer | string,
): Promise<string> {
  const full = path.join(root, relative);

  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, bytes);

  return full;
}

test('Cursor ID encoding and truncation collisions are detected', () => {
  assert.equal(encodeTranscriptId('a/b %'), 'a_2Fb_20_25');
  assert.throws(() => encodeTranscriptId('..'), /Unsafe/);

  assert.throws(
    () => assertDistinctTranscriptOwners(['a/b', 'a_2Fb']),
    /collision/,
  );

  assert.throws(
    () => assertDistinctTranscriptOwners(['x'.repeat(201), 'x'.repeat(200)]),
    /collision/,
  );

  assert.doesNotThrow(() => assertDistinctTranscriptOwners(['a', 'a']));
});

test('all six DB-owned transcript variants survive remap exactly without content UUID replacement', async (t) => {
  const root = await fixture(t);
  const sourceRoot = path.join(root, 'profile-one');
  const targetRoot = path.join(root, 'profile-two');
  const variants = [];

  for (const layout of ['nested', 'canonical', 'legacy'] as const) {
    for (const extension of ['jsonl', 'txt'] as const) {
      const relative = transcriptRelativePath(
        'child',
        layout,
        extension,
        'parent',
      );

      const bytes = Buffer.from(
        `opaque child parent ${layout} ${extension}\r\n\0`,
      );

      await put(sourceRoot, path.join('agent-transcripts', relative), bytes);
      variants.push({ relative, bytes, layout, extension });
    }
  }

  await put(
    sourceRoot,
    'agent-transcripts/unrelated/unrelated.jsonl',
    'never export',
  );

  const artifacts = await readOwnedTranscripts({
    projectRoot: sourceRoot,
    owner: 'child',
    parent: 'parent',
  });

  assert.equal(artifacts.length, 6);

  const map = new Map([
    ['child', 'new-child'],
    ['parent', 'new-parent'],
  ]);

  for (const artifact of artifacts) {
    const destination = await installHistoricalArtifact({
      projectRoot: targetRoot,
      artifact,
      ownerMap: map,
    });

    assert.equal(
      destination,
      path.join(
        targetRoot,
        'agent-transcripts',
        transcriptRelativePath(
          'new-child',
          artifact.layout!,
          artifact.extension!,
          'new-parent',
        ),
      ),
    );

    assert.deepEqual(await fs.readFile(destination), artifact.source.bytes);

    assert.equal(
      await installHistoricalArtifact({
        projectRoot: targetRoot,
        artifact,
        ownerMap: map,
      }),
      destination,
    );
  }

  for (const variant of variants)
    assert.deepEqual(
      await fs.readFile(
        path.join(sourceRoot, 'agent-transcripts', variant.relative),
      ),
      variant.bytes,
    );

  const roundtrip = await readOwnedTranscripts({
    projectRoot: targetRoot,
    owner: 'new-child',
    parent: 'new-parent',
  });

  assert.deepEqual(
    roundtrip.map((a) => a.source.sha256),
    artifacts.map((a) => a.source.sha256),
  );
});

test('transcript content never establishes parent ownership; external parents remain external', async (t) => {
  const root = await fixture(t);

  await put(
    root,
    'agent-transcripts/forged/subagents/child.jsonl',
    '{"parentComposerId":"forged"}',
  );

  assert.deepEqual(
    await readOwnedTranscripts({ projectRoot: root, owner: 'child' }),
    [],
  );

  await put(root, 'agent-transcripts/external/subagents/child.txt', 'opaque');

  const [artifact] = await readOwnedTranscripts({
    projectRoot: root,
    owner: 'child',
    parent: 'external',
  });

  const destination = await installHistoricalArtifact({
    projectRoot: path.join(root, 'dest'),
    artifact: artifact!,
    ownerMap: new Map([['child', 'new-child']]),
  });

  assert.deepEqual(
    destination.slice(path.join(root, 'dest').length).split(path.sep),
    ['', 'agent-transcripts', 'external', 'subagents', 'new-child.txt'],
  );
});

test('only structurally explicit terminal files and shell snapshots are selected', async (t) => {
  const root = await fixture(t);
  const terminal = path.join(root, 'terminals', '42.txt');
  const other = path.join(root, 'terminals', '43.txt');

  const refs = terminalReferencesFromJson(
    {
      text: other,
      arbitrary: { path: other },
      context: { terminalFiles: [{ terminalFilePath: terminal + ':2:5' }] },
      mentions: { terminalFiles: [pathToFileURL(terminal).href + '#L4-L8'] },
      attachment: {
        case: 'terminalFile',
        value: { uri: 'vscode-terminal:live' },
      },
      result: {
        terminalsFolder: path.join(root, 'terminals'),
        backgroundShellId: 44,
      },
      outside: { terminalsFolder: '/elsewhere/terminals', shellId: 43 },
      shell: { terminalInstancePath: terminal },
    },
    root,
  );

  assert.equal(refs.unsupportedLiveMentions, 1);

  assert.deepEqual(
    new Set(refs.files),
    new Set([
      terminal,
      path.join(root, 'terminals', '44.txt'),
      terminal + ':2:5',
      pathToFileURL(terminal).href + '#L4-L8',
    ]),
  );

  assert.equal(refs.files.has(other), false);
});

test('terminal snapshots become immutable history outside live terminals with line suffixes preserved', async (t) => {
  const root = await fixture(t);
  const source = path.join(root, 'source');
  const target = path.join(root, 'target');

  const bytes = Buffer.from(
    'pid: 1\n$ rm -rf /\n<script>never execute</script>\0',
  );

  const original = await put(source, 'terminals/7.txt', bytes);

  await put(source, 'terminals/unreferenced.txt', 'do not export');

  const collected = await readReferencedTerminalHistory({
    projectRoot: source,
    owner: 'old',
    references: [
      original,
      original + ':3',
      path.join(source, 'terminals', 'missing.txt'),
    ],
  });

  assert.equal(collected.artifacts.length, 1);
  assert.deepEqual(collected.missing, ['missing.txt']);

  const destination = await installHistoricalArtifact({
    projectRoot: target,
    artifact: collected.artifacts[0]!,
    ownerMap: new Map([['old', 'new']]),
  });

  assert.equal(
    destination,
    path.join(target, 'chat-transit-history/new/terminal-snapshots/7.txt'),
  );

  await assert.rejects(fs.stat(path.join(target, 'terminals')), {
    code: 'ENOENT',
  });

  assert.deepEqual(await fs.readFile(destination), bytes);
  assert.deepEqual(await fs.readFile(original), bytes);
  const installed = new Map([['7.txt', destination]]);

  assert.equal(
    remapTerminalReference(original + ':3:4', source, installed),
    destination + ':3:4',
  );

  assert.equal(
    remapTerminalReference(
      pathToFileURL(original).href + '#L3-L5',
      source,
      installed,
    ),
    pathToFileURL(destination).href + '#L3-L5',
  );

  assert.equal(
    remapTerminalReference('vscode-terminal:live', source, installed),
    'vscode-terminal:live',
  );

  const external = path.join(source, 'terminals', 'other.txt');

  assert.equal(remapTerminalReference(external, source, installed), external);
  await fs.writeFile(destination, 'conflict');

  await assert.rejects(
    installHistoricalArtifact({
      projectRoot: target,
      artifact: collected.artifacts[0]!,
      ownerMap: new Map([['old', 'new']]),
    }),
    /different bytes/,
  );

  assert.equal(await fs.readFile(destination, 'utf8'), 'conflict');
});

test('unsafe roots, ancestors, oversized files, cancellation and unknown ownership fail closed', async (t) => {
  const root = await fixture(t);

  await assert.rejects(
    readOwnedTranscripts({ projectRoot: 'relative', owner: 'a' }),
    /absolute/,
  );

  await fs.mkdir(path.join(root, 'outside'));

  await fs.symlink(
    path.join(root, 'outside'),
    path.join(root, 'agent-transcripts'),
  );

  await assert.rejects(
    readOwnedTranscripts({ projectRoot: root, owner: 'a' }),
    /Unsafe/,
  );

  const safe = path.join(root, 'safe');
  const full = await put(safe, 'terminals/1.txt', 'small');

  await fs.truncate(full, MAX_HISTORICAL_ARTIFACT_BYTES + 1);

  await assert.rejects(
    readReferencedTerminalHistory({
      projectRoot: safe,
      owner: 'a',
      references: [full],
    }),
    /size limit/,
  );

  await fs.writeFile(full, 'small');

  await assert.rejects(
    readReferencedTerminalHistory({
      projectRoot: safe,
      owner: 'a',
      references: [path.join(safe, 'terminals/../outside.txt')],
    }),
    /Unsafe/,
  );

  const signal = AbortSignal.abort();

  await assert.rejects(
    readOwnedTranscripts({ projectRoot: safe, owner: 'a', signal }),
    { name: 'AbortError' },
  );

  const { artifacts } = await readReferencedTerminalHistory({
    projectRoot: safe,
    owner: 'a',
    references: [full],
  });

  await assert.rejects(
    installHistoricalArtifact({
      projectRoot: path.join(root, 'dest'),
      artifact: artifacts[0]!,
      ownerMap: new Map(),
    }),
    /not an imported chat/,
  );

  await assert.rejects(
    installHistoricalArtifact({
      projectRoot: path.join(root, 'dest'),
      artifact: artifacts[0]!,
      ownerMap: new Map([['a', 'b']]),
      signal,
    }),
    { name: 'AbortError' },
  );
});
