import { SqliteSession } from './sqlite-session';

const APPLICATION_ID = 0x43435435; // CCT5
const SCHEMA_VERSION = 1;

/** Inventory metadata persisted independently of archive size. */
export interface BundleIndexEntry {
  path: string;
  bytes: number;
  sha256: string;
  kind: string;
}

/** Catalog metadata needed before individual chat payloads are opened. */
export interface BundleIndexChat {
  ordinal: number;
  sourceComposerId: string;
  name?: string;
}

/** Writable index owned by a staging bundle. */
export class BundleIndexWriter {
  private constructor(private readonly session: SqliteSession) {}

  static async create(
    database: string,
    signal?: AbortSignal,
  ): Promise<BundleIndexWriter> {
    const session = await SqliteSession.open({
      database,
      readOnly: false,
      signal,
    });

    try {
      await session.exec(`
        PRAGMA journal_mode=DELETE;
        PRAGMA application_id=${APPLICATION_ID};
        PRAGMA user_version=${SCHEMA_VERSION};
        CREATE TABLE inventory(
          path TEXT PRIMARY KEY,
          bytes INTEGER NOT NULL CHECK(bytes >= 0),
          sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
          kind TEXT NOT NULL
        ) WITHOUT ROWID;
        CREATE TABLE catalog(
          ordinal INTEGER PRIMARY KEY CHECK(ordinal > 0),
          source_composer_id TEXT NOT NULL UNIQUE,
          name TEXT
        );
        CREATE TABLE metadata(
          key TEXT PRIMARY KEY,
          value BLOB NOT NULL
        ) WITHOUT ROWID;
      `);

      return new BundleIndexWriter(session);
    } catch (error) {
      await session.close();

      throw error;
    }
  }

  async addInventory(entry: BundleIndexEntry): Promise<void> {
    await this.session.exec(
      'INSERT INTO inventory(path, bytes, sha256, kind) VALUES (?, ?, ?, ?)',
      [entry.path, entry.bytes, entry.sha256, entry.kind],
    );
  }

  async addChat(chat: BundleIndexChat): Promise<void> {
    await this.session.exec(
      'INSERT INTO catalog(ordinal, source_composer_id, name) VALUES (?, ?, ?)',
      [chat.ordinal, chat.sourceComposerId, chat.name ?? null],
    );
  }

  /** Flush a single-file, immutable index and release its connection. */
  async finish(): Promise<void> {
    await this.session.exec('PRAGMA optimize;');
    await this.session.close();
  }
}

/** Validate and visit an immutable v5 index without collecting its rows. */
export async function visitBundleIndex(
  database: string,
  visitor: {
    inventory(entry: BundleIndexEntry): void | Promise<void>;
    catalog?(chat: BundleIndexChat): void | Promise<void>;
  },
  signal?: AbortSignal,
): Promise<void> {
  const session = await SqliteSession.open({
    database,
    readOnly: true,
    mustExist: true,
    signal,
  });

  try {
    const identity = (
      await session.text(
        'SELECT (SELECT * FROM pragma_application_id), (SELECT * FROM pragma_user_version)',
        [],
        '\t',
      )
    ).trim();

    if (identity !== `${APPLICATION_ID}\t${SCHEMA_VERSION}`) {
      throw new Error('Export index has an unsupported schema.');
    }

    await session.rows(
      'SELECT path, bytes, sha256, kind FROM inventory ORDER BY path',
      [],
      (row) =>
        visitor.inventory({
          path: String(row[0]),
          bytes: safeNumber(row[1], 'inventory bytes'),
          sha256: String(row[2]),
          kind: String(row[3]),
        }),
    );

    if (visitor.catalog) {
      await session.rows(
        'SELECT ordinal, source_composer_id, name FROM catalog ORDER BY ordinal',
        [],
        (row) =>
          visitor.catalog!({
            ordinal: safeNumber(row[0], 'catalog ordinal'),
            sourceComposerId: String(row[1]),
            name: row[2] === null ? undefined : String(row[2]),
          }),
      );
    }
  } finally {
    await session.close();
  }
}

function safeNumber(value: unknown, label: string): number {
  const number = Number(value);

  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`Export index has invalid ${label}.`);
  }

  return number;
}
