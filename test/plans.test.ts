import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  decodePlan,
  encodePlan,
  isPlanFilename,
  planFilePath,
  planFilenameFromRef,
  planFilenamesFromChat,
  readPlanFile,
  rewriteChatPlanUris,
  rewritePlanReferences,
  writePlanFile,
} from '../src/plans';
import { TransferError } from '../src/types';

/** Allowlisted plan basename used in rewrite tests. */
const NAME = 'c++23_hello_world_9740ba02.plan.md';
/** Plan markdown bytes stored under that basename. */
const MARKDOWN = '# C++23 Hello World\n\nDo the thing.\n';

/** Throwaway plans directory deleted after the test. */
async function tempDir(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cct-plans-'));

  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  return dir;
}

test('plan filename allowlist rejects traversal and odd suffixes', () => {
  assert.equal(isPlanFilename(NAME), true);
  assert.equal(isPlanFilename('ok.plan.md'), true);
  assert.equal(isPlanFilename('../etc.plan.md'), false);
  assert.equal(isPlanFilename('.hidden.plan.md'), false);
  assert.equal(isPlanFilename('ok.plan.md.txt'), false);
  assert.equal(isPlanFilename('ok.md'), false);
});

test('planFilenameFromRef uses basename only and decodes file URLs', () => {
  assert.equal(
    planFilenameFromRef(
      `file:///home/oshokin/.cursor/plans/${encodeURIComponent(NAME)}`,
    ),
    NAME,
  );

  assert.equal(planFilenameFromRef(`/elsewhere/must-not-follow/${NAME}`), NAME);
  assert.equal(planFilenameFromRef('file:///tmp/notes.md'), null);
});

test('planFilenamesFromChat reads structured planUri and skips text', () => {
  const names = planFilenamesFromChat(
    JSON.stringify({
      planUri: `file:///evil/${NAME}`,
      text: `see file:///evil/${NAME}`,
    }),
    [
      {
        key: 'bubbleId:a:b',
        bubbleId: 'b',
        value: JSON.stringify({
          rawText: `file:///evil/${NAME}`,
          mention: { path: `/also/${NAME}` },
        }),
      },
    ],
  );

  assert.deepEqual(names.sort(), [NAME]);
});

test('encode/decode round-trips plan bytes', () => {
  const bytes = Buffer.from(MARKDOWN);
  const encoded = encodePlan(NAME, bytes);

  assert.equal(encoded.filename, NAME);
  assert.deepEqual(decodePlan(encoded), bytes);

  assert.throws(
    () => decodePlan({ ...encoded, sha256: '00'.repeat(32) }),
    /checksum/i,
  );
});

test('rewritePlanReferences remaps structured URIs and leaves markdown text', () => {
  const dest = path.join('/tmp', 'dest-plans', NAME);

  const rewritten = rewritePlanReferences(
    {
      planUri: `file:///source/${NAME}`,
      text: `keep file:///source/${NAME}`,
      rawText: `keep file:///source/${NAME}`,
      mention: {
        scheme: 'file',
        path: `/source/${NAME}`,
        fsPath: `/source/${NAME}`,
        external: `file:///source/${NAME}`,
      },
    },
    new Map([[NAME, dest]]),
  ) as Record<string, unknown>;

  const destUri = pathToFileURL(dest).href;

  assert.equal(rewritten.planUri, destUri);
  assert.equal(rewritten.text, `keep file:///source/${NAME}`);
  assert.equal(rewritten.rawText, `keep file:///source/${NAME}`);
  const mention = rewritten.mention as Record<string, unknown>;

  assert.equal(mention.path, decodeURIComponent(new URL(destUri).pathname));
  assert.equal(mention.fsPath, dest);
  assert.equal(mention.external, destUri);
});

test('local plan URI rewrite clears stale authority, query and fragment', () => {
  const dest = path.resolve('target-plans', NAME);

  const rewritten = rewritePlanReferences(
    {
      scheme: 'file',
      authority: 'source-host',
      path: `/source/${NAME}`,
      query: 'old=1',
      fragment: 'stale',
    },
    new Map([[NAME, dest]]),
  ) as Record<string, unknown>;

  assert.equal(rewritten.authority, '');
  assert.equal(rewritten.query, '');
  assert.equal(rewritten.fragment, '');

  assert.equal(
    rewritten.path,
    decodeURIComponent(pathToFileURL(dest).pathname),
  );

  assert.equal(rewritten.fsPath, dest);
});

test('rewriteChatPlanUris updates composer and bubble JSON strings', () => {
  const dest = path.join('/tmp', 'dest-plans', NAME);

  const composers = {
    a: JSON.stringify({ planUri: `file:///source/${NAME}` }),
  };

  const bubbles = {
    a: [
      {
        key: 'bubbleId:a:b',
        bubbleId: 'b',
        value: JSON.stringify({ planUri: `file:///source/${NAME}` }),
      },
    ],
  };

  rewriteChatPlanUris(composers, bubbles, new Map([[NAME, dest]]));
  assert.equal(JSON.parse(composers.a).planUri, pathToFileURL(dest).href);

  assert.equal(
    JSON.parse(bubbles.a[0]!.value).planUri,
    pathToFileURL(dest).href,
  );
});

test('read/write stay inside the allowlisted directory', async (t) => {
  const dir = await tempDir(t);
  const bytes = Buffer.from(MARKDOWN);
  const resource = encodePlan(NAME, bytes);

  await writePlanFile(dir, resource);
  const found = await readPlanFile(dir, NAME);

  assert.deepEqual(found && decodePlan(found), bytes);
  assert.equal(await readPlanFile(dir, 'missing.plan.md'), null);
  assert.throws(() => planFilePath(dir, '../escape.plan.md'), TransferError);
});

test('identical plan bytes are reused; different bytes conflict', async (t) => {
  const dir = await tempDir(t);
  const resource = encodePlan(NAME, Buffer.from(MARKDOWN));
  const dest = await writePlanFile(dir, resource);

  assert.equal(await writePlanFile(dir, resource), dest);

  await assert.rejects(
    () => writePlanFile(dir, encodePlan(NAME, Buffer.from('other\n'))),
    (err: unknown) =>
      err instanceof TransferError && err.code === 'RESOURCE_CONFLICT',
  );

  assert.equal(await fs.readFile(dest, 'utf8'), MARKDOWN);
});
