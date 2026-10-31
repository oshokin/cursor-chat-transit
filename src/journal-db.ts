import { sqlText } from './core';
import type { Receipt } from './import-policy';
import { SqliteSession } from './sqlite-session';
import type { ImportJournal, PendingImportChat } from './journal';
import { journalPathFor } from './journal';
import { TransferError } from './types';

/** Current SQLite schema. Version zero is the pre-versioned receipt journal. */
const JOURNAL_SCHEMA_VERSION = 2;

/** External side-effect class recorded by the recovery ledger. */
export type EffectKind = 'db' | 'file' | 'session';

/** Durable lifecycle of an importer side effect. */
export type EffectState =
  | 'planned'
  | 'prepared'
  | 'applied'
  | 'verified'
  | 'committed'
  | 'cleanup-pending';

/** One durable intent and the latest observation of its destination. */
export interface JournalEffect {
  operationId: string;
  effectId: string;
  kind: EffectKind;
  target: string;
  desiredHash: string;
  observedHash?: string;
  state: EffectState;
  detail?: string;
  updatedAt: string;
}

/** Pending batch stored in the v4 journal database. */
export interface PendingHead {
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
  sourceComposerId: string;
  snapshotHash: string;
  targetComposerId: string;
  /** Expected SHA-256 of the rewritten composer JSON. */
  expectedComposerHash: string;
  /** Number of expected bubble rows. */
  bubbleCount: number;
  /** complete or history-only. */
  quality: 'complete' | 'history-only';
}

/** Durable state of one importer-owned destination model projection. */
export interface ProjectionState {
  /** Immutable source composer identity. */
  sourceComposerId: string;
  /** Immutable source snapshot identity. */
  snapshotHash: string;
  /** Receipt-backed destination composer. */
  targetComposerId: string;
  /** Versioned transformation that produced the managed value. */
  projectionVersion: string;
  /** Hash of the last model config owned by the importer. */
  managedHash: string;
  /** Hash of the currently desired model config. */
  desiredHash: string;
  /** Last durable outcome. */
  outcome: 'applied' | 'already-current' | 'user-owned' | 'conflict';
  /** Last time this state was observed or changed. */
  updatedAt: string;
}

/** Prepared model projection write awaiting reconciliation. */
export interface PendingProjection extends ProjectionState {
  /** Unique projection operation. */
  operationId: string;
  /** Hash expected before the CAS write. */
  beforeHash: string;
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
    /** Directory that holds the journal database. */
    journalDir: string;
    /** Canonical target identity. */
    targetKey: string;
    /** Cancellation. */
    signal?: AbortSignal;
  }): Promise<JournalStore> {
    const filePath = journalPathFor(opts.journalDir, opts.targetKey);
    let session: SqliteSession;

    try {
      session = await SqliteSession.open({
        database: filePath,
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
      const rawVersion = (await session.exec('PRAGMA user_version;')).trim();
      const version = Number(rawVersion || '0');

      if (!Number.isSafeInteger(version) || version < 0) {
        throw new Error('Import journal schema version is invalid.');
      }

      if (version > JOURNAL_SCHEMA_VERSION) {
        throw new Error(
          `Import journal schema ${version} is newer than supported schema ${JOURNAL_SCHEMA_VERSION}.`,
        );
      }

      await session.exec(`BEGIN IMMEDIATE;
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
CREATE TABLE IF NOT EXISTS projections (
  source_composer_id TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  target_composer_id TEXT NOT NULL,
  projection_version TEXT NOT NULL,
  managed_hash TEXT NOT NULL,
  desired_hash TEXT NOT NULL,
  outcome TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (source_composer_id, snapshot_hash, target_composer_id)
);
CREATE TABLE IF NOT EXISTS pending_projection (
  operation_id TEXT PRIMARY KEY,
  source_composer_id TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  target_composer_id TEXT NOT NULL,
  projection_version TEXT NOT NULL,
  before_hash TEXT NOT NULL,
  managed_hash TEXT NOT NULL DEFAULT '',
  desired_hash TEXT NOT NULL,
  prepared_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS projection_events (
  operation_id TEXT PRIMARY KEY,
  source_composer_id TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  target_composer_id TEXT NOT NULL,
  projection_version TEXT NOT NULL,
  before_hash TEXT NOT NULL,
  after_hash TEXT NOT NULL,
  outcome TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS effects (
  operation_id TEXT NOT NULL,
  effect_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('db','file','session')),
  target TEXT NOT NULL,
  desired_hash TEXT NOT NULL,
  observed_hash TEXT,
  state TEXT NOT NULL CHECK(state IN ('planned','prepared','applied','verified','committed','cleanup-pending')),
  detail TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (operation_id, effect_id)
);
CREATE INDEX IF NOT EXISTS effects_operation_state
  ON effects(operation_id, state);
CREATE TABLE IF NOT EXISTS effect_events (
  operation_id TEXT NOT NULL,
  effect_id TEXT NOT NULL,
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  state TEXT NOT NULL,
  observed_hash TEXT,
  created_at TEXT NOT NULL
);
COMMIT;
`);

      const pendingProjectionColumns = await session.exec(
        `SELECT count(*) FROM pragma_table_info('pending_projection') WHERE name='managed_hash';`,
      );

      if (pendingProjectionColumns.trim() === '0') {
        await session.exec(`BEGIN IMMEDIATE;
ALTER TABLE pending_projection ADD COLUMN managed_hash TEXT NOT NULL DEFAULT '';
COMMIT;`);
      }

      // Zero and one are compatible receipt-journal layouts. Creating the
      // ledger above and setting user_version is their complete v2 migration.
      if (version < JOURNAL_SCHEMA_VERSION)
        await session.exec(`BEGIN IMMEDIATE;
PRAGMA user_version = ${JOURNAL_SCHEMA_VERSION};
COMMIT;`);

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

    await this.forEachReceipt((row) => {
      rows.push(row);
    });

    return rows;
  }

  /** Stream verified mappings without retaining the complete journal. */
  async forEachReceipt(
    onRow: (receipt: Receipt) => void | Promise<void>,
  ): Promise<void> {
    await this.session.queryLines(
      `SELECT json_object('source_composer_id', source_composer_id, 'snapshot_hash', snapshot_hash, 'target_composer_id', target_composer_id) FROM receipts;`,
      async (line) => {
        const row = JSON.parse(line) as {
          source_composer_id: string;
          snapshot_hash: string;
          target_composer_id: string;
        };

        await onRow({
          targetKey: this.targetKey,
          sourceComposerId: row.source_composer_id,
          snapshotHash: row.snapshot_hash,
          targetComposerId: row.target_composer_id,
          state: 'verified',
        });
      },
    );
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
  async pendingChats(
    /** Journal operation id. */
    operationId: string,
  ): Promise<PendingChatRow[]> {
    const rows: PendingChatRow[] = [];

    await this.forEachPendingChat(operationId, (row) => {
      rows.push(row);
    });

    return rows;
  }

  /** Stream chat intents for one unfinished batch. */
  async forEachPendingChat(
    operationId: string,
    onRow: (chat: PendingChatRow) => void | Promise<void>,
  ): Promise<void> {
    await this.session.queryLines(
      `SELECT json_object(
         'source_composer_id', source_composer_id,
         'snapshot_hash', snapshot_hash,
         'target_composer_id', target_composer_id,
         'expected_composer_hash', expected_composer_hash,
         'bubble_count', bubble_count,
         'quality', quality
       ) FROM pending_chats WHERE operation_id = ${sqlText(operationId)};`,
      async (line) => {
        const row = JSON.parse(line) as {
          source_composer_id: string;
          snapshot_hash: string;
          target_composer_id: string;
          expected_composer_hash: string;
          bubble_count: number;
          /** complete or history-only. */
          quality: string;
        };

        await onRow({
          sourceComposerId: row.source_composer_id,
          snapshotHash: row.snapshot_hash,
          targetComposerId: row.target_composer_id,
          expectedComposerHash: row.expected_composer_hash,
          bubbleCount: Number(row.bubble_count),
          quality: row.quality === 'history-only' ? 'history-only' : 'complete',
        });
      },
    );
  }

  /** Last durable destination projection for one source receipt. */
  async projection(input: {
    sourceComposerId: string;
    snapshotHash: string;
    targetComposerId: string;
  }): Promise<ProjectionState | undefined> {
    const line = (
      await this.session.exec(
        `SELECT json_object(
          'sourceComposerId', source_composer_id,
          'snapshotHash', snapshot_hash,
          'targetComposerId', target_composer_id,
          'projectionVersion', projection_version,
          'managedHash', managed_hash,
          'desiredHash', desired_hash,
          'outcome', outcome,
          'updatedAt', updated_at
        ) FROM projections
        WHERE source_composer_id=${sqlText(input.sourceComposerId)}
          AND snapshot_hash=${sqlText(input.snapshotHash)}
          AND target_composer_id=${sqlText(input.targetComposerId)};`,
      )
    ).trim();

    return line ? (JSON.parse(line) as ProjectionState) : undefined;
  }

  /** Projection operation left between preparation and durable audit. */
  async pendingProjection(): Promise<PendingProjection | undefined> {
    const line = (
      await this.session.exec(
        `SELECT json_object(
          'operationId', operation_id,
          'sourceComposerId', source_composer_id,
          'snapshotHash', snapshot_hash,
          'targetComposerId', target_composer_id,
          'projectionVersion', projection_version,
          'beforeHash', before_hash,
          'desiredHash', desired_hash,
          'updatedAt', prepared_at,
          'managedHash', CASE WHEN managed_hash='' THEN before_hash ELSE managed_hash END,
          'outcome', 'conflict'
        ) FROM pending_projection LIMIT 1;`,
      )
    ).trim();

    return line ? (JSON.parse(line) as PendingProjection) : undefined;
  }

  /** Persist projection intent before mutating Cursor. */
  async beginProjection(input: PendingProjection): Promise<void> {
    await this.session.exec(`BEGIN IMMEDIATE;
DELETE FROM pending_projection;
INSERT INTO pending_projection(
  operation_id, source_composer_id, snapshot_hash, target_composer_id,
  projection_version, before_hash, managed_hash, desired_hash, prepared_at
) VALUES (
  ${sqlText(input.operationId)}, ${sqlText(input.sourceComposerId)},
  ${sqlText(input.snapshotHash)}, ${sqlText(input.targetComposerId)},
  ${sqlText(input.projectionVersion)}, ${sqlText(input.beforeHash)},
  ${sqlText(input.managedHash)},
  ${sqlText(input.desiredHash)}, ${sqlText(input.updatedAt)}
);
COMMIT;`);
  }

  /** Finalize one projection outcome and append its audit event. */
  async completeProjection(
    input: PendingProjection,
    outcome: ProjectionState['outcome'],
    afterHash: string,
    managedHash = afterHash,
  ): Promise<void> {
    const now = new Date().toISOString();

    await this.session.exec(`BEGIN IMMEDIATE;
INSERT OR REPLACE INTO projections(
  source_composer_id, snapshot_hash, target_composer_id, projection_version,
  managed_hash, desired_hash, outcome, updated_at
) VALUES (
  ${sqlText(input.sourceComposerId)}, ${sqlText(input.snapshotHash)},
  ${sqlText(input.targetComposerId)}, ${sqlText(input.projectionVersion)},
  ${sqlText(managedHash)}, ${sqlText(input.desiredHash)}, ${sqlText(outcome)},
  ${sqlText(now)}
);
INSERT OR REPLACE INTO projection_events(
  operation_id, source_composer_id, snapshot_hash, target_composer_id,
  projection_version, before_hash, after_hash, outcome, created_at
) VALUES (
  ${sqlText(input.operationId)}, ${sqlText(input.sourceComposerId)},
  ${sqlText(input.snapshotHash)}, ${sqlText(input.targetComposerId)},
  ${sqlText(input.projectionVersion)}, ${sqlText(input.beforeHash)},
  ${sqlText(afterHash)}, ${sqlText(outcome)}, ${sqlText(now)}
);
DELETE FROM pending_projection WHERE operation_id=${sqlText(input.operationId)};
COMMIT;`);
  }

  /** Discard prepared intent after a verified no-write outcome. */
  async clearPendingProjection(operationId: string): Promise<void> {
    await this.session.exec(
      `DELETE FROM pending_projection WHERE operation_id=${sqlText(operationId)};`,
    );
  }

  /** Stream expected bubble hashes for one pending chat. */
  async forEachBubble(
    /** Journal operation id. */
    operationId: string,
    targetComposerId: string,
    /** Called once for each row. */
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
    await this.session.exec(`BEGIN IMMEDIATE;
DELETE FROM effects;
DELETE FROM pending_resources;
DELETE FROM pending_bubbles;
DELETE FROM pending_chats;
DELETE FROM pending;
INSERT INTO pending(operation_id, phase, backups_json) VALUES (
  ${sqlText(head.operationId)},
  ${sqlText(head.phase)},
  ${sqlText(head.backups ? JSON.stringify(head.backups) : '')}
);
COMMIT;`);
  }

  /** Record an idempotent side-effect intent before the destination is touched. */
  async planEffect(
    effect: Omit<JournalEffect, 'state' | 'observedHash' | 'updatedAt'>,
  ): Promise<void> {
    const now = new Date().toISOString();

    await this.session.exec(`BEGIN IMMEDIATE;
INSERT INTO effects(
  operation_id,effect_id,kind,target,desired_hash,state,detail,created_at,updated_at
) VALUES (
  ${sqlText(effect.operationId)},${sqlText(effect.effectId)},${sqlText(effect.kind)},
  ${sqlText(effect.target)},${sqlText(effect.desiredHash)},'planned',
  ${sqlText(effect.detail || '')},${sqlText(now)},${sqlText(now)}
)
ON CONFLICT(operation_id,effect_id) DO UPDATE SET
  kind=excluded.kind,target=excluded.target,desired_hash=excluded.desired_hash,
  detail=excluded.detail,updated_at=excluded.updated_at
WHERE effects.kind=excluded.kind AND effects.target=excluded.target
  AND effects.desired_hash=excluded.desired_hash;
INSERT INTO effect_events(operation_id,effect_id,state,created_at)
SELECT ${sqlText(effect.operationId)},${sqlText(effect.effectId)},'planned',${sqlText(now)}
WHERE changes() > 0;
COMMIT;`);

    const matches = (
      await this.session.exec(
        `SELECT count(*) FROM effects WHERE operation_id=${sqlText(effect.operationId)}
         AND effect_id=${sqlText(effect.effectId)} AND kind=${sqlText(effect.kind)}
         AND target=${sqlText(effect.target)} AND desired_hash=${sqlText(effect.desiredHash)};`,
      )
    ).trim();

    if (matches !== '1')
      throw new Error(
        'Effect id was reused for a different destination intent.',
      );
  }

  /** Advance an effect and durably retain the hash observed at the destination. */
  async setEffectState(
    operationId: string,
    effectId: string,
    state: EffectState,
    observedHash?: string,
  ): Promise<void> {
    const now = new Date().toISOString();

    await this.session.exec(`BEGIN IMMEDIATE;
INSERT INTO effect_events(operation_id,effect_id,state,observed_hash,created_at)
SELECT operation_id,effect_id,${sqlText(state)},
  ${observedHash === undefined ? 'NULL' : sqlText(observedHash)},${sqlText(now)}
FROM effects
WHERE operation_id=${sqlText(operationId)} AND effect_id=${sqlText(effectId)};
UPDATE effects SET state=${sqlText(state)},
  observed_hash=${observedHash === undefined ? 'observed_hash' : sqlText(observedHash)},
  updated_at=${sqlText(now)}
WHERE operation_id=${sqlText(operationId)} AND effect_id=${sqlText(effectId)};
COMMIT;`);

    const exists = (
      await this.session.exec(
        `SELECT count(*) FROM effects WHERE operation_id=${sqlText(operationId)}
         AND effect_id=${sqlText(effectId)};`,
      )
    ).trim();

    if (exists !== '1')
      throw new Error('Cannot advance an unknown journal effect.');
  }

  /** Stream effects for reconciliation; callers decide from observed destination hashes. */
  async forEachEffect(
    operationId: string,
    onRow: (effect: JournalEffect) => void | Promise<void>,
  ): Promise<void> {
    await this.session.queryLines(
      `SELECT json_object(
        'operationId',operation_id,'effectId',effect_id,'kind',kind,'target',target,
        'desiredHash',desired_hash,'observedHash',observed_hash,'state',state,
        'detail',detail,'updatedAt',updated_at
      ) FROM effects WHERE operation_id=${sqlText(operationId)} ORDER BY effect_id;`,
      async (line) => {
        const effect = JSON.parse(line) as JournalEffect & {
          observedHash: string | null;
          detail: string | null;
        };

        await onRow({
          ...effect,
          ...(effect.observedHash === null
            ? { observedHash: undefined }
            : { observedHash: effect.observedHash }),
          ...(effect.detail ? { detail: effect.detail } : {}),
        });
      },
    );
  }

  /** Update the phase of the open batch. */
  async setPhase(
    /** Journal operation id. */
    operationId: string,
    phase: PendingHead['phase'],
  ): Promise<void> {
    await this.session.exec(
      `UPDATE pending SET phase = ${sqlText(phase)} WHERE operation_id = ${sqlText(operationId)};`,
    );
  }

  /** Record one chat that is about to be written. */
  async addPendingChat(
    /** Journal operation id. */
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
    /** Journal operation id. */
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
DELETE FROM pending;
DELETE FROM effects;`);
  }

  /** Drop a pending batch that has no rows left in Cursor. */
  async clearPending(): Promise<void> {
    await this.session.exec(`
DELETE FROM pending_resources;
DELETE FROM pending_bubbles;
DELETE FROM pending_chats;
DELETE FROM pending;
DELETE FROM effects;`);
  }

  /** Remember how many rewritten bubbles were recorded. */
  async setBubbleCount(
    /** Journal operation id. */
    operationId: string,
    targetComposerId: string,
    /** How many items were seen. */
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
    /** Journal operation id. */
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
    /** Journal operation id. */
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
    /** Journal operation id. */
    operationId: string,
    targetComposerId: string,
    /** Called once for each row. */
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
          /** complete or history-only. */
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
  async replaceJournal(
    /** Receipt database for this destination. */
    journal: ImportJournal,
  ): Promise<void> {
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
    sourceComposerId: string;
    /** Canonical hash of the imported snapshot. */
    snapshotHash: string;
    targetComposerId: string;
    /** complete or history-only. */
    quality: 'complete' | 'history-only';
  }): Promise<void> {
    await this.session.exec(
      `INSERT OR IGNORE INTO receipts(source_composer_id, snapshot_hash, target_composer_id, quality, completed_at)
       VALUES (${sqlText(input.sourceComposerId)}, ${sqlText(input.snapshotHash)}, ${sqlText(input.targetComposerId)}, ${sqlText(input.quality)}, ${sqlText(new Date().toISOString())});`,
    );
  }

  /** Close the journal database session. */
  async close(): Promise<void> {
    await this.session.close();
  }
}
