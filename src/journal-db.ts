import { sqlText } from './core';
import type { Receipt } from './import-policy';
import { SqliteSession } from './sqlite-session';
import type { ImportJournal, PendingImportChat } from './journal';
import { journalPathFor } from './journal';
import { ensureInitFile, findSqliteExecutable } from './sqlite';
import { TransferError } from './types';

/** Pending batch stored in the v4 journal database. */
export interface PendingHead {
  /** Operation id. */
  operationId: string;
  /** How far the write progressed. */
  phase: 'prepared' | 'global-written' | 'workspace-written';
  /** Backup paths when the write started. */
  backups?: {
    /** Backup of the global database. */
    global: string;
    /** Backup of the workspace database. */
    workspace: string;
  };
}

/** One chat row inside a pending batch, without message bodies. */
export interface PendingChatRow {
  /** Source composer id. */
  sourceComposerId: string;
  /** Snapshot hash. */
  snapshotHash: string;
  /** Destination composer id. */
  targetComposerId: string;
  /** Expected SHA-256 of the rewritten composer JSON. */
  expectedComposerHash: string;
  /** Number of expected bubble rows. */
  bubbleCount: number;
  /** complete or history-only. */
  quality: 'complete' | 'history-only';
}

/** SQLite receipt store. Old JSON journals are not opened. */
export class JournalStore {
  /** Bind an open sqlite session. Use `open`. */
  private constructor(
    /** Open sqlite session for this journal file. */
    private readonly session: SqliteSession,
    /** Absolute path of the journal database. */
    readonly filePath: string,
    /** Canonical target identity this journal is partitioned by. */
    readonly targetKey: string,
  ) {}

  /** Open or create the v4 journal for this target. */
  static async open(opts: {
    /** Explicit executable from extension configuration. */
    executable?: string;
    /** Directory that holds the journal database. */
    journalDir: string;
    /** Canonical target identity. */
    targetKey: string;
    /** Cancellation. */
    signal?: AbortSignal;
  }): Promise<JournalStore> {
    const executable = opts.executable || findSqliteExecutable();

    if (!executable) throw new Error('sqlite3 is required to record imports.');

    const filePath = journalPathFor(opts.journalDir, opts.targetKey);
    const initFile = await ensureInitFile(opts.journalDir);
    let session: SqliteSession;

    try {
      session = await SqliteSession.open({
        executable,
        database: filePath,
        initFile,
        signal: opts.signal,
      });
    } catch (err) {
      const wrapped = new TransferError(
        'Import journal version is unsupported or damaged.',
      );

      wrapped.code = 'JOURNAL_INVALID';
      wrapped.detail = err instanceof Error ? err.message : String(err);

      throw wrapped;
    }

    try {
      await session.exec(`
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS receipts (
  source_composer_id TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  target_composer_id TEXT NOT NULL,
  quality TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  PRIMARY KEY (source_composer_id, snapshot_hash, target_composer_id)
);
CREATE TABLE IF NOT EXISTS pending (
  operation_id TEXT PRIMARY KEY,
  phase TEXT NOT NULL,
  backups_json TEXT
);
CREATE TABLE IF NOT EXISTS pending_chats (
  operation_id TEXT NOT NULL,
  source_composer_id TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  target_composer_id TEXT NOT NULL,
  expected_composer_hash TEXT NOT NULL,
  bubble_count INTEGER NOT NULL,
  quality TEXT NOT NULL,
  resources_known INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (operation_id, source_composer_id)
);
CREATE TABLE IF NOT EXISTS pending_resources (
  operation_id TEXT NOT NULL,
  target_composer_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  PRIMARY KEY (operation_id, target_composer_id, kind, id)
);
CREATE TABLE IF NOT EXISTS pending_bubbles (
  operation_id TEXT NOT NULL,
  target_composer_id TEXT NOT NULL,
  target_bubble_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  PRIMARY KEY (operation_id, target_composer_id, target_bubble_id)
);
`);

      const existingHex = (
        await session.exec(
          `SELECT hex(value) FROM meta WHERE key = 'target_key';`,
        )
      ).trim();

      const existing = existingHex
        ? Buffer.from(existingHex, 'hex').toString('utf8')
        : '';

      if (!existing) {
        await session.exec(
          `INSERT INTO meta(key, value) VALUES ('target_key', ${sqlText(opts.targetKey)});
INSERT INTO meta(key, value) VALUES ('version', '1');`,
        );
      } else if (existing !== opts.targetKey) {
        await session.close();

        throw new Error('Import journal does not match this workspace.');
      }

      return new JournalStore(session, filePath, opts.targetKey);
    } catch (error) {
      await session.close();
      if (error instanceof TransferError) throw error;

      const wrapped = new TransferError(
        'Import journal version is unsupported or damaged.',
      );

      wrapped.code = 'JOURNAL_INVALID';
      wrapped.detail = error instanceof Error ? error.message : String(error);

      throw wrapped;
    }
  }

  /** Verified mappings for policy checks. */
  async receipts(): Promise<Receipt[]> {
    const rows: Receipt[] = [];

    await this.session.queryLines(
      `SELECT json_object('source_composer_id', source_composer_id, 'snapshot_hash', snapshot_hash, 'target_composer_id', target_composer_id) FROM receipts;`,
      (line) => {
        const row = JSON.parse(line) as {
          source_composer_id: string;
          snapshot_hash: string;
          target_composer_id: string;
        };

        rows.push({
          targetKey: this.targetKey,
          sourceComposerId: row.source_composer_id,
          snapshotHash: row.snapshot_hash,
          targetComposerId: row.target_composer_id,
          state: 'verified',
        });
      },
    );

    return rows;
  }

  /** The unfinished batch, if one exists. */
  async pending(): Promise<PendingHead | undefined> {
    const line = (
      await this.session.exec(
        `SELECT json_object('operation_id', operation_id, 'phase', phase, 'backups_json', backups_json) FROM pending LIMIT 1;`,
      )
    ).trim();

    if (!line) return undefined;

    const row = JSON.parse(line) as {
      operation_id: string;
      phase: string;
      backups_json: string | null;
    };

    const operationId = row.operation_id;
    const phase = row.phase;
    const backups = row.backups_json || '';

    if (
      phase !== 'prepared' &&
      phase !== 'global-written' &&
      phase !== 'workspace-written'
    ) {
      throw new Error('Import journal phase is unsupported.');
    }

    return {
      operationId,
      phase,
      backups: backups
        ? (JSON.parse(backups) as PendingHead['backups'])
        : undefined,
    };
  }

  /** Chat rows for the pending batch. */
  async pendingChats(operationId: string): Promise<PendingChatRow[]> {
    const rows: PendingChatRow[] = [];

    await this.session.queryLines(
      `SELECT json_object(
         'source_composer_id', source_composer_id,
         'snapshot_hash', snapshot_hash,
         'target_composer_id', target_composer_id,
         'expected_composer_hash', expected_composer_hash,
         'bubble_count', bubble_count,
         'quality', quality
       ) FROM pending_chats WHERE operation_id = ${sqlText(operationId)};`,
      (line) => {
        const row = JSON.parse(line) as {
          source_composer_id: string;
          snapshot_hash: string;
          target_composer_id: string;
          expected_composer_hash: string;
          bubble_count: number;
          quality: string;
        };

        rows.push({
          sourceComposerId: row.source_composer_id,
          snapshotHash: row.snapshot_hash,
          targetComposerId: row.target_composer_id,
          expectedComposerHash: row.expected_composer_hash,
          bubbleCount: Number(row.bubble_count),
          quality: row.quality === 'history-only' ? 'history-only' : 'complete',
        });
      },
    );

    return rows;
  }

  /** Stream expected bubble hashes for one pending chat. */
  async forEachBubble(
    operationId: string,
    targetComposerId: string,
    onRow: (bubbleId: string, sha256: string) => void,
  ): Promise<void> {
    await this.session.queryLines(
      `SELECT json_object('target_bubble_id', target_bubble_id, 'sha256', sha256) FROM pending_bubbles
       WHERE operation_id = ${sqlText(operationId)}
         AND target_composer_id = ${sqlText(targetComposerId)};`,
      (line) => {
        const row = JSON.parse(line) as {
          target_bubble_id: string;
          sha256: string;
        };

        onRow(row.target_bubble_id, row.sha256);
      },
    );
  }

  /** Replace any pending batch with a new head. */
  async beginPending(head: PendingHead): Promise<void> {
    await this.session.exec(`
DELETE FROM pending_bubbles;
DELETE FROM pending_chats;
DELETE FROM pending;
INSERT INTO pending(operation_id, phase, backups_json) VALUES (
  ${sqlText(head.operationId)},
  ${sqlText(head.phase)},
  ${sqlText(head.backups ? JSON.stringify(head.backups) : '')}
);`);
  }

  /** Update the phase of the open batch. */
  async setPhase(
    operationId: string,
    phase: PendingHead['phase'],
  ): Promise<void> {
    await this.session.exec(
      `UPDATE pending SET phase = ${sqlText(phase)} WHERE operation_id = ${sqlText(operationId)};`,
    );
  }

  /** Record one chat that is about to be written. */
  async addPendingChat(
    operationId: string,
    chat: PendingChatRow,
  ): Promise<void> {
    await this.session.exec(
      `INSERT INTO pending_chats(operation_id, source_composer_id, snapshot_hash, target_composer_id, expected_composer_hash, bubble_count, quality, resources_known)
       VALUES (${sqlText(operationId)}, ${sqlText(chat.sourceComposerId)}, ${sqlText(chat.snapshotHash)}, ${sqlText(chat.targetComposerId)}, ${sqlText(chat.expectedComposerHash)}, ${chat.bubbleCount}, ${sqlText(chat.quality)}, 1);`,
    );
  }

  /** Batch pending hashes before taking any Cursor database write lock. */
  async beginPreparation(): Promise<void> {
    await this.session.exec('BEGIN;');
  }
  /** Make expected hashes durable before publishing chat data. */
  async finishPreparation(): Promise<void> {
    await this.session.exec('COMMIT;');
  }
  /** Discard an interrupted preparation; no target rows were published. */
  async cancelPreparation(): Promise<void> {
    await this.session.exec('ROLLBACK;');
  }

  /** Record the hash of one rewritten bubble. */
  async addPendingBubble(
    operationId: string,
    targetComposerId: string,
    targetBubbleId: string,
    sha256: string,
  ): Promise<void> {
    await this.session.exec(
      `INSERT OR IGNORE INTO pending_bubbles(operation_id, target_composer_id, target_bubble_id, sha256)
       VALUES (${sqlText(operationId)}, ${sqlText(targetComposerId)}, ${sqlText(targetBubbleId)}, ${sqlText(sha256)});`,
    );
  }

  /** Turn the pending batch into receipts. */
  async completePending(): Promise<void> {
    const head = await this.pending();

    if (!head) return;

    await this.session.exec(`
INSERT INTO receipts(source_composer_id, snapshot_hash, target_composer_id, quality, completed_at)
SELECT source_composer_id, snapshot_hash, target_composer_id, quality, ${sqlText(new Date().toISOString())}
FROM pending_chats WHERE operation_id = ${sqlText(head.operationId)};
DELETE FROM pending_resources;
DELETE FROM pending_bubbles;
DELETE FROM pending_chats;
DELETE FROM pending;`);
  }

  /** Drop a pending batch that has no rows left in Cursor. */
  async clearPending(): Promise<void> {
    await this.session.exec(`
DELETE FROM pending_resources;
DELETE FROM pending_bubbles;
DELETE FROM pending_chats;
DELETE FROM pending;`);
  }

  /** Remember how many rewritten bubbles were recorded. */
  async setBubbleCount(
    operationId: string,
    targetComposerId: string,
    count: number,
  ): Promise<void> {
    await this.session.exec(
      `UPDATE pending_chats SET bubble_count = ${count}
       WHERE operation_id = ${sqlText(operationId)}
         AND target_composer_id = ${sqlText(targetComposerId)};`,
    );
  }

  /** Record one resource checksum the pending chat must still match. */
  async addPendingResource(
    operationId: string,
    targetComposerId: string,
    kind: string,
    id: string,
    sha256: string,
  ): Promise<void> {
    await this.session.exec(
      `INSERT OR IGNORE INTO pending_resources(operation_id, target_composer_id, kind, id, sha256)
       VALUES (${sqlText(operationId)}, ${sqlText(targetComposerId)}, ${sqlText(kind)}, ${sqlText(id)}, ${sqlText(sha256)});`,
    );
  }

  /** Whether resource checksums were recorded for this pending chat. */
  async resourcesKnown(
    operationId: string,
    targetComposerId: string,
  ): Promise<boolean> {
    const line = (
      await this.session.exec(
        `SELECT resources_known FROM pending_chats
         WHERE operation_id = ${sqlText(operationId)}
           AND target_composer_id = ${sqlText(targetComposerId)};`,
      )
    ).trim();

    return line === '1';
  }

  /** Stream expected resource checksums. */
  async forEachResource(
    operationId: string,
    targetComposerId: string,
    onRow: (kind: string, id: string, sha256: string) => void,
  ): Promise<void> {
    await this.session.queryLines(
      `SELECT json_object('kind', kind, 'id', id, 'sha256', sha256) FROM pending_resources
       WHERE operation_id = ${sqlText(operationId)}
         AND target_composer_id = ${sqlText(targetComposerId)};`,
      (line) => {
        const row = JSON.parse(line) as {
          kind: string;
          id: string;
          sha256: string;
        };

        onRow(row.kind, row.id, row.sha256);
      },
    );
  }

  /** Read the journal into the in-memory shape used by tests. */
  async readJournal(): Promise<ImportJournal> {
    const receipts: ImportJournal['receipts'] = [];

    await this.session.queryLines(
      `SELECT json_object(
         'source_composer_id', source_composer_id,
         'snapshot_hash', snapshot_hash,
         'target_composer_id', target_composer_id,
         'quality', quality,
         'completed_at', completed_at
       ) FROM receipts;`,
      (line) => {
        const row = JSON.parse(line) as {
          source_composer_id: string;
          snapshot_hash: string;
          target_composer_id: string;
          quality: 'complete' | 'history-only';
          completed_at: string;
        };

        receipts.push({
          sourceComposerId: row.source_composer_id,
          snapshotHash: row.snapshot_hash,
          targetComposerId: row.target_composer_id,
          quality: row.quality,
          completedAt: row.completed_at,
        });
      },
    );

    const head = await this.pending();

    if (!head) return { version: 1, targetKey: this.targetKey, receipts };
    const chats = await this.pendingChats(head.operationId);
    const pendingChats: PendingImportChat[] = [];

    for (const chat of chats) {
      const expectedBubbles: Array<[string, string]> = [];

      await this.forEachBubble(
        head.operationId,
        chat.targetComposerId,
        (id, sha) => {
          expectedBubbles.push([id, sha]);
        },
      );

      const expectedResources: PendingImportChat['expectedResources'] = [];

      const known = await this.resourcesKnown(
        head.operationId,
        chat.targetComposerId,
      );

      if (known) {
        await this.forEachResource(
          head.operationId,
          chat.targetComposerId,
          (kind, id, sha256) => {
            if (
              kind === 'kv' ||
              kind === 'image' ||
              kind === 'plan' ||
              kind === 'canvas'
            ) {
              expectedResources!.push({ kind, id, sha256 });
            }
          },
        );
      }

      pendingChats.push({
        sourceComposerId: chat.sourceComposerId,
        snapshotHash: chat.snapshotHash,
        targetComposerId: chat.targetComposerId,
        bubbleMap: [],
        expectedComposerHash: chat.expectedComposerHash,
        expectedBubbles,
        ...(known ? { expectedResources } : {}),
        quality: chat.quality,
      });
    }

    return {
      version: 1,
      targetKey: this.targetKey,
      receipts,
      pending: {
        operationId: head.operationId,
        phase: head.phase,
        chats: pendingChats,
        backups: head.backups,
      },
    };
  }

  /** Replace receipts and the pending batch. */
  async replaceJournal(journal: ImportJournal): Promise<void> {
    await this.session.exec(`DELETE FROM receipts;`);
    await this.clearPending();

    for (const receipt of journal.receipts) {
      await this.addReceipt({
        sourceComposerId: receipt.sourceComposerId,
        snapshotHash: receipt.snapshotHash,
        targetComposerId: receipt.targetComposerId,
        quality: receipt.quality,
      });
    }

    if (!journal.pending) return;

    await this.beginPending({
      operationId: journal.pending.operationId,
      phase: journal.pending.phase,
      backups: journal.pending.backups,
    });

    for (const chat of journal.pending.chats) {
      const known = chat.expectedResources !== undefined;

      await this.session.exec(
        `INSERT INTO pending_chats(operation_id, source_composer_id, snapshot_hash, target_composer_id, expected_composer_hash, bubble_count, quality, resources_known)
         VALUES (${sqlText(journal.pending.operationId)}, ${sqlText(chat.sourceComposerId)}, ${sqlText(chat.snapshotHash)}, ${sqlText(chat.targetComposerId)}, ${sqlText(chat.expectedComposerHash)}, ${chat.expectedBubbles.length}, ${sqlText(chat.quality)}, ${known ? 1 : 0});`,
      );

      for (const [bubbleId, sha] of chat.expectedBubbles) {
        await this.addPendingBubble(
          journal.pending.operationId,
          chat.targetComposerId,
          bubbleId,
          sha,
        );
      }

      for (const dep of chat.expectedResources || []) {
        await this.addPendingResource(
          journal.pending.operationId,
          chat.targetComposerId,
          dep.kind,
          dep.id,
          dep.sha256,
        );
      }
    }
  }

  /** Record one verified chat immediately. */
  async addReceipt(input: {
    /** Source composer id. */
    sourceComposerId: string;
    /** Canonical hash of the imported snapshot. */
    snapshotHash: string;
    /** Destination composer id. */
    targetComposerId: string;
    /** complete or history-only. */
    quality: 'complete' | 'history-only';
  }): Promise<void> {
    await this.session.exec(
      `INSERT OR IGNORE INTO receipts(source_composer_id, snapshot_hash, target_composer_id, quality, completed_at)
       VALUES (${sqlText(input.sourceComposerId)}, ${sqlText(input.snapshotHash)}, ${sqlText(input.targetComposerId)}, ${sqlText(input.quality)}, ${sqlText(new Date().toISOString())});`,
    );
  }

  /** Close the sqlite3 process. */
  async close(): Promise<void> {
    await this.session.close();
  }
}
