import { execSql, parseListRows } from './sqlite';
import { bubbleRange, sqlText } from './core';
import type { Layout, SchemaInfo, SqliteConn } from './types';

/** ItemTable columns this adapter requires to read or write. */
const REQUIRED_ITEM_COLS = new Set(['key', 'value']);
/** cursorDiskKV columns this adapter requires. */
const REQUIRED_KV_COLS = new Set(['key', 'value']);
/** composerHeaders columns required to read the table. */
const REQUIRED_HEADER_COLS = new Set(['composerId', 'value']);

/** Extra header columns we may populate; unknown NOT NULL columns block writes. */
const KNOWN_HEADER_WRITE_COLS = new Set([
  'composerId',
  'value',
  'workspaceId',
  'createdAt',
  'lastUpdatedAt',
  'isArchived',
  'isSubagent',
  'recency',
  'checkpointAt',
]);

/** JSON Pointers rewritten on composer bodies during copy-mode remap. */
export const COMPOSER_BODY_POINTERS = ['/composerId'] as const;

/** JSON Pointers rewritten on bubble bodies during copy-mode remap. */
export const BUBBLE_BODY_POINTERS = [
  '/composerId',
  '/bubbleId',
  '/nextBubbleId',
  '/previousBubbleId',
] as const;

/** Object fields whose keys are bubble ids and must be renamed, not substring-replaced. */
export const BUBBLE_KEYED_FIELDS = [
  'fullConversationHeadersByBubbleId',
  'conversationMap',
  'bubbles',
] as const;

/** Collect PRAGMA column names from `table_info` rows. */
function colNames(rows: string[][]): Set<string> {
  return new Set(rows.map((r) => r[1]));
}

/** Return whether `have` contains every required column. */
function hasAll(have: Set<string>, need: Set<string>): boolean {
  for (const n of need) if (!have.has(n)) return false;

  return true;
}

/** True when PRAGMA reports a NOT NULL column we do not populate and that has no default. */
function extraRequiredWithoutDefault(
  rows: string[][],
  known: Set<string>,
): boolean {
  for (const r of rows) {
    const name = r[1];
    const notnull = r[3] === '1';
    const dflt = r[4];

    if (!notnull || known.has(name)) continue;
    if (dflt !== '' && dflt !== undefined) continue;

    return true;
  }

  return false;
}

/** Read known table names and `PRAGMA table_info` for each. */
export async function readSchema(conn: SqliteConn): Promise<SchemaInfo> {
  const tablesText = await execSql({
    ...conn,
    sql: "SELECT name, type FROM sqlite_schema WHERE name IN ('ItemTable','cursorDiskKV','composerHeaders');",
    readOnly: true,
  });

  const types: Record<string, string> = {};
  const tables = new Set<string>();

  for (const [name, type] of parseListRows(tablesText, 2)) {
    if (!name) continue;
    types[name] = type;
    if (type === 'table') tables.add(name);
  }

  const info: Record<string, string[][]> = {};

  for (const name of Object.keys(types)) {
    const pragma = await execSql({
      ...conn,
      sql: `PRAGMA table_info(${name});`,
      readOnly: true,
    });

    info[name] = parseListRows(pragma, 6);
  }

  return { tables, types, info };
}

/** Map a schema snapshot onto supported layout flags. Unknown layouts are write-blocked. */
export function detectLayout(schema: SchemaInfo): Layout {
  const { tables, types, info } = schema;

  const itemOk =
    tables.has('ItemTable') &&
    hasAll(colNames(info.ItemTable || []), REQUIRED_ITEM_COLS);

  const kvOk =
    tables.has('cursorDiskKV') &&
    hasAll(colNames(info.cursorDiskKV || []), REQUIRED_KV_COLS);

  const headerInfo = info.composerHeaders || [];
  const headerCols = colNames(headerInfo);
  const headerType = types.composerHeaders;
  const headerPresent = Boolean(headerType);
  const isHeaderTable = headerType === 'table';
  const headerOk = isHeaderTable && hasAll(headerCols, REQUIRED_HEADER_COLS);

  const extraHeaderConstraints =
    isHeaderTable &&
    extraRequiredWithoutDefault(headerInfo, KNOWN_HEADER_WRITE_COLS);

  const extraItemConstraints =
    tables.has('ItemTable') &&
    extraRequiredWithoutDefault(info.ItemTable || [], REQUIRED_ITEM_COLS);

  const extraKvConstraints =
    tables.has('cursorDiskKV') &&
    extraRequiredWithoutDefault(info.cursorDiskKV || [], REQUIRED_KV_COLS);

  const headerWriteBlocked =
    headerPresent && (!headerOk || extraHeaderConstraints || !isHeaderTable);

  const canWriteGlobal =
    itemOk &&
    kvOk &&
    !headerWriteBlocked &&
    !extraItemConstraints &&
    !extraKvConstraints;

  const canWriteWorkspace = itemOk && !extraItemConstraints;
  let unsupportedReason: string | null = null;

  if (headerPresent && !isHeaderTable) {
    unsupportedReason = 'composerHeaders exists but is not a table';
  } else if (headerPresent && extraHeaderConstraints) {
    unsupportedReason =
      'composerHeaders has a NOT NULL column without a default that this extension does not write';
  } else if (headerPresent && !headerOk) {
    unsupportedReason =
      'composerHeaders exists but required columns are missing';
  } else if (extraItemConstraints) {
    unsupportedReason =
      'ItemTable has a NOT NULL column without a default that this extension does not write';
  } else if (extraKvConstraints) {
    unsupportedReason =
      'cursorDiskKV has a NOT NULL column without a default that this extension does not write';
  } else if (!itemOk || !kvOk) {
    unsupportedReason = 'required ItemTable/cursorDiskKV columns missing';
  }

  return {
    itemTable: itemOk,
    cursorDiskKV: kvOk,
    composerHeaders: headerOk,
    headerColumns: [...headerCols],
    canWriteGlobal,
    canWriteWorkspace,
    writeBlocked: !canWriteGlobal,
    unsupportedReason,
  };
}

/** Index range scan for `bubbleId:<composerId>:` keys. */
export function bubbleKeySql(composerId: string): {
  lower: string;
  upper: string;
  sql: string;
} {
  const { lower, upper } = bubbleRange(composerId);

  return {
    lower,
    upper,
    sql: `SELECT hex(key), hex(typeof(value)), hex(value) FROM cursorDiskKV WHERE key >= ${sqlText(lower)} AND key < ${sqlText(upper)} ORDER BY key;`,
  };
}
