import { traceIO } from './transfer-events';
import fs from 'node:fs';
import path from 'node:path';
import { finiteInt, sqlText } from './core';
import { backupDatabase } from './sqlite';
import type { ComposerHeader } from './types';

/** `.backup` into destDir and refuse to continue if the file was not created. */
export async function createVerifiedBackup(opts: {
  /** Absolute path of the sqlite3 executable. */
  executable: string;
  /** Database file to back up. */
  database: string;
  /** Directory that will receive the timestamped backup file. */
  destDir: string;
  /** sqlite3 `-init` file that sets timeouts and modes. */
  initFile: string;
  /** Cancellation for the backup child. */
  signal?: AbortSignal;
  /** Wall-clock limit for the backup child. */
  timeoutMs?: number;
  /** SQLite busy timeout applied through the init file. */
  busyTimeoutMs?: number;
}): Promise<string> {
  const { executable, database, destDir, initFile, signal } = opts;

  await fs.promises.mkdir(destDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  const dest = path.join(
    destDir,
    `${path.basename(database, '.vscdb')}.backup-${stamp}.vscdb`,
  );

  await traceIO(
    'Back up database',
    { source: database, destination: dest },
    () =>
      backupDatabase({
        executable,
        database,
        dest,
        initFile,
        signal,
        timeoutMs: opts.timeoutMs,
        busyTimeoutMs: opts.busyTimeoutMs,
      }),
  );

  if (!fs.existsSync(dest) || fs.statSync(dest).size === 0) {
    throw new Error(`Backup was not created: ${dest}`);
  }

  return dest;
}

/** INSERT missing cursorDiskKV rows (caller wraps BEGIN/COMMIT). */
export function kvInsertSql(
  pairs: Array<{ key: string; value: string }>,
): string {
  let sql = '';

  for (const { key, value } of pairs) {
    const v =
      typeof value === 'string' ? sqlText(value) : sqlText(String(value));

    sql += `INSERT INTO cursorDiskKV (key, value) SELECT ${sqlText(key)}, ${v} WHERE NOT EXISTS (SELECT 1 FROM cursorDiskKV WHERE key = ${sqlText(key)});\n`;
  }

  return sql;
}

/** SQL literal for raw SQLite TEXT or BLOB bytes. */
export function sqliteResourceLiteral(
  bytes: Buffer,
  kind: 'text' | 'blob',
): string {
  if (!Buffer.isBuffer(bytes)) throw new TypeError('Expected Buffer');
  const literal = `X'${bytes.toString('hex')}'`;

  return kind === 'blob' ? literal : `CAST(${literal} AS TEXT)`;
}

/** INSERT missing typed resources and conflict if the existing row differs. */
export function kvInsertTypedSql(
  rows: Array<{ key: string; storageClass: 'text' | 'blob'; bytes: Buffer }>,
): string {
  let sql =
    'CREATE TEMP TABLE IF NOT EXISTS cct_resource_guard (ok INTEGER CONSTRAINT cct_resource_conflict CHECK(ok = 1));\n';

  for (const row of rows) {
    const keySql = sqlText(row.key);
    const valueSql = sqliteResourceLiteral(row.bytes, row.storageClass);
    const expectedHex = row.bytes.toString('hex').toUpperCase();
    const expectedType = row.storageClass;

    sql += `INSERT INTO cursorDiskKV (key, value) SELECT ${keySql}, ${valueSql} WHERE NOT EXISTS (SELECT 1 FROM cursorDiskKV WHERE key = ${keySql});\n`;
    sql += `INSERT INTO temp.cct_resource_guard(ok) SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM cursorDiskKV WHERE key = ${keySql} AND typeof(value) = '${expectedType}' AND upper(hex(CAST(value AS BLOB))) = '${expectedHex}');\n`;
  }

  return sql;
}

/** INSERT OR REPLACE one ItemTable JSON value. */
export function itemReplaceSql(key: string, value: unknown): string {
  return `INSERT OR REPLACE INTO ItemTable (key, value) VALUES (${sqlText(key)}, ${sqlText(JSON.stringify(value))});`;
}

/** Replace ItemTable JSON only when the stored raw value still matches `expectedRaw`. */
export function itemCasReplaceSql(
  key: string,
  expectedRaw: string | null,
  value: unknown,
): string {
  const next = sqlText(JSON.stringify(value));
  const keySql = sqlText(key);

  // With sqlite3 -bail, a failed guard terminates before COMMIT. Closing
  // the connection then rolls back the entire open transaction.
  const guard =
    'CREATE TEMP TABLE IF NOT EXISTS cct_cas_guard (ok INTEGER CONSTRAINT cct_cas_conflict CHECK(ok = 1));';

  const check =
    'INSERT INTO temp.cct_cas_guard(ok) SELECT 0 WHERE changes() != 1;';

  if (expectedRaw === null) {
    return [
      guard,
      `INSERT INTO ItemTable (key, value) SELECT ${keySql}, ${next} WHERE NOT EXISTS (SELECT 1 FROM ItemTable WHERE key = ${keySql});`,
      check,
    ].join('\n');
  }

  const expectedHex = Buffer.from(expectedRaw, 'utf8')
    .toString('hex')
    .toUpperCase();

  return [
    guard,
    `UPDATE ItemTable SET value = ${next} WHERE key = ${keySql} AND upper(hex(value)) = '${expectedHex}';`,
    check,
  ].join('\n');
}

/** True when a sqlite3 CLI failure is a CAS mismatch. */
export function isCasConflict(err: unknown): boolean {
  const text =
    err instanceof Error
      ? `${err.message} ${'stderr' in err ? String((err as { stderr?: string }).stderr || '') : ''}`
      : String(err);

  return text.includes('cas-conflict') || text.includes('cct_cas_conflict');
}

/** True when a typed resource insert hit a different existing value. */
export function isResourceConflict(err: unknown): boolean {
  const text =
    err instanceof Error
      ? `${err.message} ${'stderr' in err ? String((err as { stderr?: string }).stderr || '') : ''}`
      : String(err);

  return (
    text.includes('resource-conflict') || text.includes('cct_resource_conflict')
  );
}

/** Append a column to an INSERT if the live table has it. */
export function maybeCol(
  cols: string[],
  vals: string[],
  name: string,
  enabled: boolean,
  value: string,
): void {
  if (!enabled) return;
  cols.push(name);
  vals.push(value);
}

/** UPSERT composerHeaders using only columns present on this DB. */
export function headerUpsertSql(
  composers: ComposerHeader[],
  workspaceId: string,
  columns: string[],
): string {
  /** True when this composerHeaders table actually has `name`. */
  const has = (name: string) => columns.includes(name);
  let sql = '';

  for (const c of composers) {
    if (!c || !c.composerId) continue;
    const created = finiteInt(c.createdAt, Date.now());
    const updated = finiteInt(c.lastUpdatedAt, created);
    const checkpoint = finiteInt(c.conversationCheckpointLastUpdatedAt, null);
    const cols = ['composerId', 'value'];
    const vals = [sqlText(c.composerId), sqlText(JSON.stringify(c))];

    maybeCol(
      cols,
      vals,
      'workspaceId',
      has('workspaceId'),
      sqlText(workspaceId),
    );

    maybeCol(cols, vals, 'createdAt', has('createdAt'), String(created));

    maybeCol(
      cols,
      vals,
      'lastUpdatedAt',
      has('lastUpdatedAt'),
      String(updated),
    );

    maybeCol(
      cols,
      vals,
      'isArchived',
      has('isArchived'),
      c.isArchived ? '1' : '0',
    );

    maybeCol(
      cols,
      vals,
      'isSubagent',
      has('isSubagent'),
      c.isBestOfNSubcomposer ? '1' : '0',
    );

    maybeCol(cols, vals, 'recency', has('recency'), String(updated));

    maybeCol(
      cols,
      vals,
      'checkpointAt',
      has('checkpointAt'),
      checkpoint === null ? 'NULL' : String(checkpoint),
    );

    sql += `INSERT INTO composerHeaders (${cols.join(',')}) VALUES (${vals.join(',')})\n`;

    sql += `ON CONFLICT(composerId) DO UPDATE SET ${cols
      .filter((n) => n !== 'composerId')
      .map((n) => `${n}=excluded.${n}`)
      .join(',')};\n`;
  }

  return sql;
}
