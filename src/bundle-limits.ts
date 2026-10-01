/** Public archive label. Version 4 is the only format this build reads or writes. */
export const BUNDLE_FORMAT = 'cursor-chat-transit';

/** On-disk format version. Older numbers are rejected, not converted. */
export const EXPORT_FORMAT_VERSION = 4;

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

/** Property-count limit for one JSON record. */
export const MAX_JSON_KEYS = 100_000;

/** Maximum UTF-8 length of one object key. */
export const MAX_JSON_KEY_BYTES = 64 * 1024;

/** SQLite value this adapter will read or write as one row. */
export const MAX_SQLITE_VALUE_BYTES = 32 * 1024 * 1024;

/** ZIP members, including manifest and inventory. */
export const MAX_ZIP_ENTRIES = 250_000;

/** Digits in generated chat and part directory names. */
export const ORDINAL_WIDTH = 6;
