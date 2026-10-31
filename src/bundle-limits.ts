/** Public archive label. */
export const BUNDLE_FORMAT = 'cursor-chat-transit';

/** Current on-disk writer format. Readers also accept version 4. */
export const EXPORT_FORMAT_VERSION = 5;

/** Oldest seekable bundle version accepted by this build. */
export const MIN_BUNDLE_FORMAT_VERSION = 4;

/** Semantic snapshot algorithm stored with new receipts. */
export const FINGERPRINT_ALGORITHM = 'cct-snapshot-v2';

/** Uncompressed NDJSON part target. A larger single record gets its own part. */
export const NDJSON_PART_BYTES = 16 * 1024 * 1024;

/** Maximum UTF-8 size of one JSON value, including its trailing newline. */
export const MAX_JSON_RECORD_BYTES = 32 * 1024 * 1024;

/** Maximum UTF-8 size of manifest.json. */
export const MAX_MANIFEST_BYTES = 1024 * 1024;

/** Nesting limit for one JSON record. */
export const MAX_JSON_DEPTH = 64;

/**
 * Property-count limit for one JSON record.
 * A long agent transcript stores one object per message in
 * `fullConversationHeadersOnly`. 100,000 properties is only about 7,000
 * messages. The byte and depth limits still bound the record.
 */
export const MAX_JSON_KEYS = 1_000_000;

/** SQLite value this adapter will read or write as one row. */
export const MAX_SQLITE_VALUE_BYTES = 32 * 1024 * 1024;

/** Maximum protocol line carrying two SQLite values plus framing overhead. */
export const MAX_SQLITE_ROW_LINE_BYTES = 2 * MAX_SQLITE_VALUE_BYTES + 64 * 1024;

/** ZIP members, including manifest and inventory. */
export const MAX_ZIP_ENTRIES = 250_000;

/** Aggregate expanded bytes accepted from one archive. */
export const MAX_EXPANDED_ARCHIVE_BYTES = 64 * 1024 * 1024 * 1024;

/** Maximum expansion ratio for a non-empty compressed ZIP member. */
export const MAX_ZIP_COMPRESSION_RATIO = 1_000;

/** Digits in generated chat and part directory names. */
export const ORDINAL_WIDTH = 6;
