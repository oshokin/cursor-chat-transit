import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  journalPathFor,
  loadJournal,
  saveJournal,
  writeJsonAtomic,
  completePendingImport,
} from '../src/journal';
import type { ImportJournal } from '../src/journal';
import { TransferError } from '../src/types';

test('completion preserves receipts and quality without mutating the pending journal', () => {
  const journal: ImportJournal = {
    version: 1,
    targetKey: 'workspace',
    receipts: [
      {
        sourceComposerId: 'earlier',
        snapshotHash: 'old',
        targetComposerId: 'existing',
        quality: 'complete',
        completedAt: 'before',
      },
    ],
    pending: {
      operationId: 'op',
      phase: 'workspace-written',
      chats: [
        {
          sourceComposerId: 'source',
          snapshotHash: 'hash',
          targetComposerId: 'target',
          quality: 'history-only',
          bubbleMap: [],
          expectedBubbles: [],
          expectedComposerHash: 'body',
          expectedResources: [],
        },
      ],
    },
  };

  const before = structuredClone(journal);
  const completed = completePendingImport(journal, 'now');

  assert.deepEqual(journal, before);
  assert.equal(completed.pending, undefined);
  assert.equal(completed.targetKey, 'workspace');

  assert.deepEqual(completed.receipts, [
    journal.receipts[0],
    {
      sourceComposerId: 'source',
      snapshotHash: 'hash',
      targetComposerId: 'target',
      quality: 'history-only',
      completedAt: 'now',
    },
  ]);
});

test('completion cannot fabricate a receipt without a pending import', () => {
  assert.throws(
    () =>
      completePendingImport({
        version: 1,
        targetKey: 'workspace',
        receipts: [],
      }),
    /No pending import/,
  );
});

test('corrupt journal fails closed before any caller can write chats', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cct-journal-'));

  try {
    const targetKey = '{"target":"a"}';

    await fs.writeFile(journalPathFor(dir, targetKey), '{broken');

    await assert.rejects(
      () => loadJournal(dir, targetKey),
      (err: unknown) =>
        err instanceof TransferError && err.code === 'JOURNAL_INVALID',
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('atomic journal replace keeps a readable file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cct-journal-'));

  try {
    const file = path.join(dir, 'j.json');

    await writeJsonAtomic(file, { version: 1, ok: true });

    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), {
      version: 1,
      ok: true,
    });

    await saveJournal(dir, {
      version: 1,
      targetKey: 't',
      receipts: [],
    });

    const loaded = await loadJournal(dir, 't');

    assert.equal(loaded.version, 1);
    assert.equal(loaded.receipts.length, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('legacy pending without expectedResources still loads', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cct-journal-'));

  try {
    await saveJournal(dir, {
      version: 1,
      targetKey: 't',
      receipts: [],
      pending: {
        operationId: 'op',
        phase: 'workspace-written',
        chats: [
          {
            sourceComposerId: 's',
            snapshotHash: 'h',
            targetComposerId: 't',
            bubbleMap: [],
            expectedComposerHash: 'x',
            expectedBubbles: [],
            quality: 'complete',
          },
        ],
      },
    });

    const loaded = await loadJournal(dir, 't');

    assert.equal(loaded.pending?.chats[0]?.expectedResources, undefined);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
