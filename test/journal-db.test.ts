import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JournalStore } from '../src/journal-db';
import { journalPathFor } from '../src/journal';
import { execSql, execSqlScript } from '../src/sqlite';
import { TransferError } from '../src/types';

async function fixture(
  t: { after: (fn: () => Promise<void>) => void },
  targetKey = 'workspace',
) {
  const journalDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cct-ledger-'));

  t.after(() => fs.rm(journalDir, { recursive: true, force: true }));

  return {
    journalDir,
    targetKey,
    database: journalPathFor(journalDir, targetKey),
  };
}

test('legacy journal migrates explicitly and preserves receipts', async (t) => {
  const item = await fixture(t);

  await execSqlScript({
    database: item.database,
    sql: `CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE receipts(
 source_composer_id TEXT,snapshot_hash TEXT,target_composer_id TEXT,
 quality TEXT,completed_at TEXT,
 PRIMARY KEY(source_composer_id,snapshot_hash,target_composer_id)
);
INSERT INTO meta VALUES('target_key','workspace'),('version','1');
INSERT INTO receipts VALUES('source','hash','target','complete','now');`,
  });

  const journal = await JournalStore.open(item);

  try {
    assert.equal((await journal.receipts()).length, 1);

    assert.equal(
      (
        await execSql({
          database: item.database,
          sql: 'PRAGMA user_version;',
        })
      ).trim(),
      '2',
    );
  } finally {
    await journal.close();
  }
});

test('future journal schema is rejected without modification', async (t) => {
  const item = await fixture(t);

  await execSqlScript({
    database: item.database,
    sql: 'PRAGMA user_version=999;',
  });

  await assert.rejects(
    JournalStore.open(item),
    (error: unknown) =>
      error instanceof TransferError &&
      error.code === 'JOURNAL_INVALID' &&
      /newer/.test(error.detail || ''),
  );

  assert.equal(
    (
      await execSql({
        database: item.database,
        sql: 'PRAGMA user_version;',
      })
    ).trim(),
    '999',
  );
});

test('beginPending replacement is atomic when interrupted', async (t) => {
  const item = await fixture(t);
  const journal = await JournalStore.open(item);

  try {
    await journal.beginPending({ operationId: 'old', phase: 'prepared' });

    await execSqlScript({
      database: item.database,
      sql: `CREATE TRIGGER stop_replace BEFORE DELETE ON pending
            BEGIN SELECT RAISE(ABORT,'interrupted'); END;`,
    });

    await assert.rejects(
      journal.beginPending({ operationId: 'new', phase: 'prepared' }),
      /interrupted/,
    );

    assert.equal(
      (
        await execSql({
          database: item.database,
          sql: 'SELECT operation_id FROM pending;',
        })
      ).trim(),
      'old',
    );
  } finally {
    await journal.close();
  }
});

test('effect intent and observed hash updates are idempotent', async (t) => {
  const item = await fixture(t);
  const journal = await JournalStore.open(item);

  try {
    await journal.beginPending({ operationId: 'op', phase: 'prepared' });

    const input = {
      operationId: 'op',
      effectId: 'file:plan:a.md',
      kind: 'file' as const,
      target: 'plan:a.md',
      desiredHash: 'a'.repeat(64),
    };

    await journal.planEffect(input);
    await journal.planEffect(input);

    await journal.setEffectState(
      'op',
      input.effectId,
      'verified',
      input.desiredHash,
    );

    const effects: Array<{ state: string; observedHash?: string }> = [];

    await journal.forEachEffect('op', (effect) => {
      effects.push(effect);
    });

    assert.deepEqual(effects, [
      { ...effects[0], state: 'verified', observedHash: input.desiredHash },
    ]);

    await assert.rejects(
      journal.planEffect({ ...input, desiredHash: 'b'.repeat(64) }),
      /reused/,
    );

    await assert.rejects(
      journal.setEffectState('op', 'missing', 'applied'),
      /unknown/,
    );
  } finally {
    await journal.close();
  }
});
