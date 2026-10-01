# Cursor Chat Transit: architecture, storage, and language

This document is the combined design record for the adapter: modules and pipelines, product language, repeat-import policy, and every SQL table, column, and nested field the code addresses. Contributor commands live in [development.md](development.md).

The adapter is **Cursor Chat Transit**. It copies chat snapshots between local Cursor storage pairs. It does not synchronise two live conversations, clone an installation, or certify that an imported Agent session will continue on the original server.

## Contents

1. [Product language and icon](#1-product-language-and-icon)
2. [Modules](#2-modules)
3. [Storage versus identity](#3-storage-versus-identity)
4. [Export](#4-export)
5. [Import](#5-import)
6. [Repeat import](#6-repeat-import)
7. [Storage contract](#7-storage-contract)
8. [Export ZIP contract](#8-export-zip-contract)
9. [Partial recovery and completeness](#9-partial-recovery-and-completeness)
10. [Read-only inventory of an unknown schema](#10-read-only-inventory-of-an-unknown-schema)
11. [Open work](#11-open-work)
12. [Sources](#12-sources)

---

## 1. Product language and icon

The product name is **Cursor Chat Transit**. The short view title is **Chat Transit**. User actions are **Export chats** and **Import chats**. `Transit` is a brand, not a verb that replaces export or import. Ordinary English `transfer` remains acceptable in technical prose; it must not be mechanically rewritten into the brand name.

| Surface                          | Preferred copy                                            |
| -------------------------------- | --------------------------------------------------------- |
| Product title, settings category | Cursor Chat Transit                                       |
| Short view title                 | Chat Transit                                              |
| Sidebar actions                  | Export chats / Import chats                               |
| Last operation section           | Recent activity                                           |
| Empty operation state            | No imports or exports yet                                 |
| Empty state detail               | Choose an action to get started.                          |
| File hint                        | Import and export ZIP archives. Existing chats are kept.  |
| Operation output action          | Open operation log                                        |
| Diagnostics modal actions        | Copy report / Close                                       |
| Successful single import         | Imported 1 chat                                           |
| Successful multiple import       | Imported 2 chats                                          |
| Changed source snapshot          | Added 1 updated chat version                              |
| Changed snapshot explanation     | A separate copy was created. Your existing chat was kept. |
| Already imported snapshot        | These chats are already imported. No changes made.        |

Sidebar labels use sentence case. All-caps section headings are a visual convention, not a second vocabulary. Command Palette titles keep their existing title case. Diagnostics uses a native modal with Copy report and Close; there is no Diagnostic Output channel.

Incomplete results take priority over the already-imported and updated-version success branches. A skipped damaged chat must remain visible when other chats were already imported. An updated copy with missing data is still incomplete. Count phrases must agree in number. Ask the user to quit and reopen Cursor only when a completed import wrote new chats; a pure no-op needs no restart. The sidebar and host action both require `importNeedsRestart`, set from the import result. Starting another transfer or reporting an error clears it. Exports, cancelled imports, and unverified partial commits never offer Quit; partial commits direct the user to the operation log.

The Quit action calls `workbench.action.quit` without an extension modal. Cursor owns quit confirmation, unsaved-work prompts and shutdown vetoes; the extension does not change those settings. A disabled host confirmation can mean immediate shutdown. Check desktop Cursor and command availability at runtime, then recheck transfer activity and import eligibility after that asynchronous lookup. Ignore overlapping requests until the command settles. A resolved command does not prove the application closed: preserve the import result and permit retry. The guard covers this extension host; it does not coordinate transfers in other Cursor instances.

The package id is `oshokin.cursor-chat-transit`. Settings, commands and views use `cursorChatTransit.*`. The project uses the MIT license; `LICENSE` retains the original notice alongside the notice for subsequent work.

Development began from the Cursor Chat Transfer codebase. Its supplied MIT license contained `Copyright (c) 2022 Riccardo Mazzarini`; that notice is retained with `Copyright (c) 2026 Oleg Shokin`. Cursor Chat Transit has its own package identity and implementation. Renaming or refactoring a project is not by itself a basis for removing inherited license notices. See the [MIT license terms](https://opensource.org/license/mit) and the project [LICENSE](../LICENSE).

`resources/icons/activity-bar.svg` is the canonical monochrome mark. The host shows it on the Activity Bar. The sidebar does not repeat the product title, tagline, or mark. Existing CSP and message allowlists remain.

The mark uses a 24 × 24 viewBox, a closed bubble path, rounded joins and caps, 1.5-unit strokes, and two internal arrows. Sidebar colour comes from `currentColor` and VS Code theme tokens. Activity Bar styling is provided by the host’s icon rendering. Do not put a coloured app tile or drop shadow into the Activity Bar.

`resources/marketplace.svg` and its 256 × 256 PNG are presentation derivatives. Regenerate both from the canonical paths when the mark changes. They are not a second icon concept. Inspect the mark at 16/24/32 px, in light, dark, and high-contrast host themes, and at narrow sidebar widths. Browser previews do not prove host rendering. There is no new production dependency or icon framework.

---

## 2. Modules

Sources in `src/` compile to `out/`.

| Module                                                                                                                                                 | Responsibility                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `extension.ts`                                                                                                                                         | Register commands, sidebar and output channels; connect actions                                 |
| `quit-cursor.ts`                                                                                                                                       | Optional **Quit Cursor** after import adds chats; delegates confirmation to Cursor, no relaunch |
| `extension-state.ts`                                                                                                                                   | One operation state, cancellation, UI refresh and host operation lock                           |
| `extension-settings.ts` / `extension-workspaces.ts`                                                                                                    | Settings and remembered local directories; storage discovery and workspace selection            |
| `extension-export.ts` / `extension-import.ts`                                                                                                          | Export/import dialogs, progress and results                                                     |
| `extension-diagnostics.ts` / `extension-errors.ts`                                                                                                     | Diagnostic report; failure presentation and Output reveal                                       |
| `sidebar-provider.ts`, `webview/`                                                                                                                      | Small themed UI and message allowlist                                                           |
| `operation-ui.ts` / `operation-log.ts`                                                                                                                 | Pure result wording, progress calculation and operation logging                                 |
| `transfer.ts`                                                                                                                                          | Stable export/import entry points; no storage implementation                                    |
| `transfer-context.ts`                                                                                                                                  | Database pair inspection, connection options, WAL-safe export snapshot                          |
| `export-transfer.ts`                                                                                                                                   | Shared selected-chat reader and object/file export paths                                        |
| `import-transfer.ts`                                                                                                                                   | Lock, validation and ordered import orchestration                                               |
| `import-selection.ts`                                                                                                                                  | Recovery classification, fingerprint and repeat-import decision                                 |
| `import-prepare.ts`                                                                                                                                    | Clone IDs, check resources, back up both databases and prepare pending records                  |
| `import-commit.ts`                                                                                                                                     | Resource installation, global/workspace commits and CAS retry                                   |
| `import-verify.ts`                                                                                                                                     | Read back bodies, blobs, images, plans and workspace binding                                    |
| `import-reconcile.ts`                                                                                                                                  | Reconcile a previous pending attempt and inspect target presence                                |
| `chat-json.ts` / `chat-copy.ts`                                                                                                                        | Validate/remap known JSON fields and clone chat IDs                                             |
| `import-policy.ts` / `journal.ts`                                                                                                                      | Snapshot policy; journal persistence and a shared receipt constructor                           |
| `db.ts`                                                                                                                                                | Stable database entry points                                                                    |
| `db-read.ts` / `db-headers.ts` / `db-write.ts`                                                                                                         | Reads and test hooks; workspace/header resolution; SQL writes and backups                       |
| `dependencies.ts`                                                                                                                                      | Stable resource entry points                                                                    |
| `resource-codec.ts` / `chat-dependencies.ts`                                                                                                           | Resource envelopes and limits; supported reference discovery                                    |
| `resource-export.ts` / `resource-import.ts`                                                                                                            | Collect export resources; validate and plan resource installation                               |
| `attachments.ts` / `plans.ts`                                                                                                                          | Format-specific image and plan I/O                                                              |
| `resource-bytes.ts` / `resource-files.ts`                                                                                                              | Shared byte validation and no-clobber file installation                                         |
| `sqlite.ts` / `sqlite-process.ts` / `schema.ts`                                                                                                        | SQLite transport, stream parsing and schema capability checks                                   |
| `core.ts`, `paths.ts`, `types.ts`, `format.ts`, `recovery.ts`                                                                                          | Existing focused domain primitives, types, file format and recovery rules                       |
| `export-name.ts`, `picker.ts`, `workspace-presentation.ts`, `file-dialogs.ts`, `output-ui.ts`, `diagnostics-ui.ts`, `lock.ts`, `conversation-state.ts` | Existing focused UI, locking and conversation-state adapters                                    |

The production UI runs transfers in `transfer-worker.ts` via `transfer-process.ts`. The v4 path uses `export-bundle.ts`, `import-bundle.ts`, `bundle-reader.ts`, `bundle-writer.ts`, `ndjson-io.ts`, and `bundle-zip.ts`. `journal-db.ts` stores receipts and pending hashes in SQLite. `import-batches.ts` limits global write transactions; `import-cleanup.ts` verifies and removes unpublished message batches on retry. `progress-model.ts` tracks actual phase/file progress. `transfer-events.ts` scopes concrete file events to an operation and chat. Object-based helpers retained for small test fixtures are not a legacy file-import path.

There is no custom JSON parser. Individual bounded values use `JSON.parse`; NDJSON framing handles byte chunks and record limits. Metadata indexes live in private SQLite databases. Cursor's main database receives only prepared rows; preparation and journal fsyncs happen before its write lock.

---

## 3. Storage versus identity

`storageRoot` is a **local** Cursor user-data directory. `workspaceIdentity` is a URI that may be `vscode-remote` with an SSH authority. A remote project does not imply remote chat SQLite.

If `cursorChatTransit.userDataDir` is set, that root is authoritative: missing paired databases are an error. Automatic discovery does not fall back to `~/.config/Cursor` (or the operating-system equivalent) in that case. It does not mix workspace A with global B.

Header matching uses `workspaceKey()` (kind + scheme, authority, path, query, and fragment), not path-only comparison.

---

## 4. Export

1. Detect schema. Errors are errors, not “no chats”.
2. Union headers from the workspace ItemTable, workspace `composerHeaders`, the global table, and the global blob.
3. Duplicate IDs: table metadata wins; unique legacy IDs stay. If that record omits `name`, a non-empty name from a lower-rank header is copied; an explicit empty name is left empty.
4. `selectedComposerIds` is a hint, not the catalogue.
5. Missing bodies are incomplete.
6. Bubble keys are range-scanned, not scanned with `LIKE` prefixes.
7. The global database is snapshotted with `.backup` before bodies, blobs, and images are read.
8. `_v:18` conversationState blob ids (prompt roots, turns, todos, summaries, plans, file-state bytes, and blobs those records point at) become `agentKv:blob:*` resources. A missing required id makes `complete` false.
9. Image UUIDs are read from the workspace `images/` directory; the export does not store filesystem paths.
10. Plan filenames are taken from structured `planUri` / URI objects; bytes are read only from `{plansDir}/{basename}` (`~/.cursor/plans` by default). Export JSON paths are never followed.

---

## 5. Import

1. Acquire a process lock shared by all importers using the same global database. The UI also prevents overlapping local commands.
2. Extract v4 ZIP entries incrementally into a private temporary directory. Reject unsafe paths, duplicates, unsupported formats, oversized JSON entries and invalid hashes/counts.
3. Build a temporary SQLite index and compute canonical fingerprints from bounded records. Check schemas, resource metadata, conversation references and repeat-import policy before creating backups.
4. Create verified backups of the global and workspace databases. Record pending chat identities and expected hashes in the private journal.
5. Remap known ID/URI fields only; preserve message text. Assemble the bounded composer row on disk and prepare all message/resource rows in a private SQLite database. Cache resource maps per chat and batch pending-hash writes in one private transaction.
6. Copy prepared dependencies and message rows into the global database in transactions limited to 128 rows / 8 MiB. A single permitted SQLite value can exceed the batch budget, up to 32 MiB. Check existing keys for identical bytes and storage class inside each transaction. Yield between batches. The composer/header is not published yet.
7. Publish the composer and global header in a final transaction with header compare-and-swap retries. Bind the chat into the workspace, verify recorded resources and composer bytes, then save its receipt. Global and workspace databases are separate transactions, not an atomic pair.
8. On cancellation/error after a durable batch, retain the pending journal. On retry, unpublished bubble rows are removed only if they belong to the recorded target and their hashes/current bytes match. Changed or unknown rows are preserved. Verified completed chats get receipts; unfinished later chats can be retried. Never delete shared blobs or restore the whole profile automatically.

No JSON parsing, per-message file writes, resource-directory enumeration or journal updates occur inside the main database's batch transaction. SQLite still has one writer; no time guarantee is possible for a slow or unhealthy disk. No global journal mode, synchronous setting or checkpoint policy is changed.

Cancellation, operation timeout and worker IPC disconnect stop owned SQLite children. Connection close awaits child exit so lock cleanup cannot return while that child is still writing. Do not delete Cursor's database, WAL or SHM files to recover an extension lock.

---

## 6. Repeat import

Status: implemented from 0.0.28 (`src/import-policy.ts`, `src/journal.ts`, importer), with resource-hash reconciliation in 0.0.29. The maintainer reports successful transferred-chat continuation. A recorded cross-platform matrix for the new candidate, attachments, SSH and Output behavior remains to be completed.

### 6.1 Product decision

**Import copies chat snapshots. It does not synchronise two live conversations.**

- The same version of the same source chat in the same target is skipped without changing the existing chat.
- A different version of that source chat creates a new copy and keeps the previous one.
- A new source chat is an ordinary import of a new copy.
- Identical titles with different source composer IDs are different chats.
- If the user continued or renamed a previously imported target, a repeat of the old snapshot is skipped; new target messages and the target name are kept.
- If a previously imported copy is verifiably deleted, a new manual import may restore it as a new copy.
- If part of an earlier attempt remains in the database, do not mint a new UUID map and do not report “already imported” until the state has been checked.

Do not add an overwrite, merge, update, or keep-both menu for each chat. Do not add background synchronisation, a conflict editor, or a CRDT. Do not update by comparing `lastUpdatedAt`: machine clocks differ, and both branches may contain new messages.

Updating “by ID” is unsafe because the first import remaps composer and bubble IDs, and the target chat may already have grown another branch. Signatures, server IDs, agent state, and blob references form Cursor’s closed graph. Appending messages by timestamp is not a correct merge.

### 6.2 User experience without extra steps

Keep one selected workspace and two buttons: `Export chats` and `Import chats`. The policy, in documentation:

> Already imported versions are skipped. Changed versions are added as separate copies.

The user chooses a file once. The overall result appears in the existing Recent activity block:

| Situation                       | Title / text                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------- |
| Import 3 new, 5 already present | `Imported 3 chats · 5 already imported`                                                     |
| Repeats only                    | `These chats are already imported. No changes made.`                                        |
| New version of a known chat     | `Added 1 updated chat version. A separate copy was created. Your existing chat was kept.`   |
| History-only                    | `Imported 2 chats. 2 chats have missing data. You may not be able to continue these chats.` |
| Unfinished previous write       | `The previous import needs checking. No new copies were created.` + `Open operation log`    |

On a clean no-op: do not create new backup files, do not write SQLite, do not change selected or focused IDs, and do not ask for a Cursor restart. Checking the journal and database, and reporting, are allowed. The log records separate totals `imported`, `alreadyImported`, `newVersions`, `historyOnly`, `skippedUnusable`.

Preserve the chat title from the export. “Separate copy / updated version” is a status in the extension report, not a requirement to replace the chat name with a timestamp. The journal records a bounded name and identifiers, not full message text.

One overall result instead of a popup per chat. Details are an expandable list of names and reasons. If there is no confirmed native Cursor API for opening a chat ID, do not invent a false `Open chat` link: offer `Copy chat name` / `Copy chat ID` with an accurate action name. Do not guess an unconfirmed command ID.

Do not add Undo until there is a safe deletion of only entities that this operation created and the user has not changed. Restoring an entire SQLite backup is not operation Undo.

### 6.3 Identity: three distinct notions

```ts
type SourceIdentity = string; // original composerId; opaque, never the title

type TargetIdentity = string; // canonical pair of DB paths + workspace identity

type SnapshotHash = string; // versioned SHA-256 of one validated source snapshot
```

The source composer ID remains the original identifier until remap. A newly minted UUID must not be used as a deduplication key. Do not deduplicate by title, filename, file mtime, export time, or a single hash of the whole batch file.

The target key includes the canonical `realpath` of the global database and the workspace database, `storageId`, and `workspaceKey(kind, uri)`. Two profiles with the same project, and two SSH hosts with the same `/repo`, are different targets. Do not lowercase Linux paths; do not use a UI-friendly name as identity. If a confirmed identity is absent, keep separation by the actual database-path pair plus `storageId`.

Source IDs are treated as unique within the contract of the originating Cursor. Two different conversations with the same manually substituted composerId and different contents yield different snapshot hashes and separate copies. Moving an already imported copy from a new machine creates a new source ID: full transitive provenance is not supported in v1.

### 6.4 Fingerprint of one chat

Include in the fingerprint:

1. The algorithm version, for example `cct-snapshot-v1`.
2. The original composer ID.
3. The header in full, except `workspaceIdentifier`, which is a rebinding to a workspace.
4. The parsed JSON composer body, including unknown fields and `conversationState`. `grouping.textPreview` is omitted: it is a derived list preview, not part of the conversation.
5. Every bubble payload of that composer; sort records by bubble ID; JSON object keys deterministically. **Preserve array order inside payloads**, especially `fullConversationHeadersOnly`.
6. Only dependency descriptors reachable from that chat through the supported adapter: key, UUID, or plan filename, storage class, hash of verified bytes, byteLength, and extension for images. Do not include another chat’s blob merely because it landed in the same batch.
7. Markers of missing dependencies and the computed quality `complete` / `history-only`.

Do not include the export filename, JSON location, overall `summary`, export timestamp, or batch order. Header and body timestamps that are part of chat content remain in the v1 fingerprint: it is better to obtain a new version conservatively than to discard an unknown important change unnoticed. Optimising away “another twenty volatile fields” waits for real fixtures.

A change of resource checksum or bytes changes the snapshot. Supplying previously missing resources creates another version. A repaired complete export must not skip merely because the message text is unchanged.

Missing source resources are represented explicitly. Verify resource metadata and bytes before using them in a fingerprint; do not trust a manifest summary as proof of completeness. Image variants participate separately in the fingerprint.

Canonical hash and action selection: [`../src/import-policy.ts`](../src/import-policy.ts). This is a limited canonicalisation of the internal JSON contract, not a claim of RFC 8785 conformance. NaN, Infinity, and illegal depth are rejected. Parsing of the source JSON is already bounded by existing limits; the helper does not replace the validator.

### 6.5 Receipt storage and recovery

The receipt store is a private SQLite database (`journal-db.ts`), partitioned by canonical target identity. Tables hold receipts, pending operations, pending chats, expected bubble hashes and expected resource hashes. No chat message bodies are retained in receipt memory. The source snapshot hash identifies the source export; a completed target is allowed to evolve after a verified import.

Before writing Cursor data, persist pending metadata. A crash between global and workspace publication remains a partial import requiring inspection; do not claim those two commits are atomic. Recovery verifies available chats and preserves modified data. Unpublished, unchanged message batches can be removed safely using byte comparisons inside short transactions before retrying.

`Clear stale lock` uses the captured PID/token/path, verifies that the process is absent and the token still matches, and rejects symlinks, live owners and changed locks. It operates only on an extension `.lock` file. Unreadable ownership cannot be safely inferred. Journals and Cursor SQLite sidecars are never deleted by this action.

### 6.6 Regression gates

Tests cover repeated imports, changed source snapshots, continued target chats, deleted bindings, ID remapping, resource collisions, cancellation before and after durable batches, IPC disconnect, concurrent writes between batches, changed pending rows, multi-chat retry, live/stale lock ownership, bounded NDJSON, unsafe ZIP members and progress/logging contracts. The opt-in `npm run test:perf` benchmark uses temporary databases and exposes message count/size settings. Host tests and manual Cursor continuation checks remain distinct from SQLite fixtures.

---

## 7. Storage contract

Audit date: 2026-09-29. Re-check base: archive `cursor-chat-transfer-20260929-072214.zip`, adapter `0.0.29`, before the module extraction described above. SHA-256: `db7b9e4c547b322a908ed25a654f60af437256f1823cf52505fb63c1c05f5ba6`. This refactor preserves the storage contract; it adds no Cursor tables or export format version.

This is a catalogue of **every table, SQL column, and significant nested field that this code addresses explicitly**. It is not a complete or official specification of Cursor’s closed store. Real user `state.vscdb` files were not attached to that archive. Types and constraints of the production schema cannot be inferred from synthetic tests alone. A Cursor version name does not replace a capability check of the schema.

Legend: **R** — read; **W** — write; **P** — preserve an opaque field without claiming to understand its semantics. A “possible purpose” is not a proven Cursor contract.

### 7.1 Files and storage areas

| Object             | Path relative to local Cursor user-data                   | Use                                                     |
| ------------------ | --------------------------------------------------------- | ------------------------------------------------------- |
| Global database    | `User/globalStorage/state.vscdb`                          | Shared chat bodies, messages, resources, global headers |
| Workspace database | `User/workspaceStorage/<storageId>/state.vscdb`           | Binding and chat lists of the selected project          |
| Workspace metadata | `User/workspaceStorage/<storageId>/workspace.json`        | Project URI; a JSON file, not an SQL table              |
| Images             | `User/workspaceStorage/<storageId>/images/<uuid>.<ext>`   | Observed attachment adapter                             |
| Backups            | `cursor-chat-transit-backups/` beside the global database | `.backup` of both databases before import               |
| Export             | User-chosen `*.cursor-chat.json`                          | Extension format; not a native SQLite dump              |

Sources: [`paths.ts`](../src/paths.ts), [`dependencies.ts`](../src/dependencies.ts), [`transfer.ts`](../src/transfer.ts).

Default local roots: macOS `~/Library/Application Support/Cursor`; Windows `%APPDATA%/Cursor` with fallback `~/AppData/Roaming/Cursor`; Linux `$XDG_CONFIG_HOME/Cursor` or `~/.config/Cursor`. The explicit setting `cursorChatTransit.userDataDir` takes precedence; the adapter must not silently switch to another profile.

Remote SSH is a property of the **project URI**, not proof that the chat database is remote. The extension has `extensionKind: ["ui"]` and works with a local database pair. The location of the import JSON is a third independent entity: `file:` is read locally, `vscode-remote:` through `workspace.fs`.

Do not copy only the main file of a live WAL database: current pages may reside in `-wal`. For a snapshot use the SQLite backup API / `.backup`. See [SQLite backup](https://sqlite.org/backup.html) and [WAL](https://sqlite.org/wal.html).

### 7.2 Application SQL tables known to the adapter

| Table             | Global database                                     | Workspace database                                                         | Columns known to the extension                                                                                            |
| ----------------- | --------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `ItemTable`       | R/W, required for the current global write contract | R/W, required for workspace write                                          | `key`, `value`                                                                                                            |
| `cursorDiskKV`    | R/W, required for global write                      | May be discovered; import does not write bodies there                      | `key`, `value`                                                                                                            |
| `composerHeaders` | R/W when a supported table is present               | R when present; current import does not update this table in the workspace | `composerId`, `value`, `workspaceId`, `createdAt`, `lastUpdatedAt`, `isArchived`, `isSubagent`, `recency`, `checkpointAt` |

In total: **three application tables, thirteen known SQL columns**. `composerData:*`, `bubbleId:*`, and `agentKv:blob:*` are key values inside `cursorDiskKV`, not separate tables. `conversationState` is a JSON field, not an SQL column.

Sources: [`schema.ts`](../src/schema.ts) (`readSchema`, `detectLayout`), [`db.ts`](../src/db.ts), [`transfer.ts`](../src/transfer.ts) (`importFromObject`).

#### What detectLayout checks

- Object names and kinds via `sqlite_schema`; writes expect tables.
- Presence of required column names via `PRAGMA table_info`.
- An unknown `NOT NULL` column without a default blocks writes.
- `composerHeaders` as a view, or a table without `composerId`/`value`, blocks global write.
- A missing `composerHeaders` is allowed when legacy structures are present.

**Limit:** the existing detector does not prove type correctness, UNIQUE/PK, every CHECK, triggers, foreign keys, or generated columns. For example, `ON CONFLICT(composerId)` in fact requires a suitable unique constraint. Do not describe `canWriteGlobal` as a formal certification of an arbitrary schema.

### 7.3 ItemTable

| SQL column | Representation in the fixtures used                               | Operations | Extension contract                                                                                                           |
| ---------- | ----------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `key`      | `TEXT PRIMARY KEY`                                                | R/W        | String key of a setting or state; exact comparison                                                                           |
| `value`    | Column declared `BLOB`; JSON may have actual storage class `text` | R/W        | For known keys, a UTF-8 JSON object. Read via `hex(value)`; written as a JSON string. Do not treat every table value as JSON |

SQLite uses the type of the value, not only the column declaration: [datatypes](https://sqlite.org/datatype3.html). Do not normalise every row of the table and do not change its DDL.

#### Key `composer.composerData` — workspace

| JSON field in `value`    | Type expected by the code | Read / mutation                                                                                                      |
| ------------------------ | ------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `allComposers`           | `ComposerHeader[]`        | Workspace catalogue; import appends headers of new IDs and does not replace the whole array                          |
| `selectedComposerIds`    | `string[]`                | Import keeps existing elements and adds new IDs without duplicates. An empty array does not mean there is no history |
| `lastFocusedComposerIds` | `string[]`                | New IDs are prepended; the resulting array is limited to 10 elements                                                 |
| Other fields             | Unknown                   | P: spread of the original object on write; their semantics are unchanged                                             |

Source: `db.resolveComposers`, workspace transaction of `transfer.importFromObject`.

#### Key `composer.composerHeaders` — global legacy blob

| JSON field in `value` | Type               | Read / mutation                                                                    |
| --------------------- | ------------------ | ---------------------------------------------------------------------------------- |
| `allComposers`        | `ComposerHeader[]` | Global legacy catalogue; filtered by workspace on read; new IDs appended on import |
| Other fields          | Unknown            | P: preserved                                                                       |

Source: `db.resolveComposers`, global transaction of `transfer.importFromObject`.

#### Writes and concurrent changes

`itemCasReplaceSql(key, expectedRaw, next)` must change the record only when the current raw JSON matches the previously read value. If the key was absent, insertion is allowed only while it remains absent. On mismatch the attempt must roll back and re-read; the current orchestrator allows up to five attempts.

Metadata CAS uses a TEMP CHECK guard (`cct_cas_guard`) so sqlite3 `-bail` stops before `COMMIT`. CHECK itself usually rolls back only the statement; the full attempt rolls back because the CLI exits and the uncommitted connection is closed. See [SQLite ON CONFLICT](https://sqlite.org/lang_conflict.html).

### 7.4 cursorDiskKV

| SQL column | Representation in fixtures | Operations | Contract                                                                                                    |
| ---------- | -------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------- |
| `key`      | `TEXT PRIMARY KEY`         | R/W        | Exact record key; the prefixes below have different semantics                                               |
| `value`    | Usually declared `BLOB`    | R/W        | For composer/bubble, UTF-8 JSON; for blob resources, opaque bytes with the actual `typeof(value)` preserved |

#### Key families

| Key                                | What is stored           | What the extension does                                                                 |
| ---------------------------------- | ------------------------ | --------------------------------------------------------------------------------------- |
| `composerData:<composerId>`        | JSON of the chat body    | Reads in full, changes only known local ID fields, writes a copy under a new ID         |
| `bubbleId:<composerId>:<bubbleId>` | JSON of a message record | Reads by composer-ID range; remaps the ID in the key and in known fields                |
| `agentKv:blob:<64 lowercase hex>`  | Opaque resource          | Copies bytes and storage class only for references found by the supported state adapter |
| `checkpointId:*`                   | Unsupported              | Does not copy; semantics are not established by this code                               |
| `ofsContent:*`                     | Unsupported              | Does not copy; the extension does not restore old repository files                      |
| Other `agentKv:*` and unknown keys | Unsupported              | Does not scan or transfer automatically                                                 |

Names `agentKv:blob:<hash>` are treated as resource addresses, yet the checksum of the exported **value** is computed separately. The code does not require the key suffix to equal the SHA-256 of the value. These are two different fields; such equality must not be introduced without real fixtures.

#### Message range

For a supported UUID composer ID:

```sql
SELECT hex(key), hex(typeof(value)), hex(value)
FROM cursorDiskKV
WHERE key >= 'bubbleId:<composerId>:'
  AND key <  'bubbleId:<composerId>;'
ORDER BY key;
```

An index on `key` permits a range scan under the expected schema and comparison. This is **not conversation order**: order is given by `fullConversationHeadersOnly`. Do not replace the query with an unconditional `LIKE '%…%'`, and do not change user indexes or PRAGMA for speed. Sources: `schema.bubbleKeySql`, `core.bubbleRange`, `test/cli.sqlite.test.ts`.

#### Composer-body fields the code understands

| JSON path                                             | Expected representation                                     | Behaviour on transfer                                                                                                                                                               |
| ----------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/composerId`                                         | String                                                      | Rewritten to the new copy ID                                                                                                                                                        |
| `/_v`                                                 | Internal version number                                     | For non-empty state the adapter allows 18 or an absent field; other given values are rejected. This is code behaviour, not a compatibility guarantee for every payload without `_v` |
| `/name`                                               | Chat name, if present                                       | P: preserved; the UI prefers the header name. Do not generate a name from a timestamp                                                                                               |
| `/conversationState`                                  | `~` + canonical base64                                      | P: preserved in full. Blob ids are collected from the known agent state fields and from the records they name                                                                       |
| `/fullConversationHeadersOnly`                        | Array of objects                                            | Array order is preserved; each `bubbleId` must refer to an existing record of this chat                                                                                             |
| `/fullConversationHeadersOnly/*/bubbleId`             | String                                                      | Rewritten by the scoped bubble map                                                                                                                                                  |
| `/fullConversationHeadersOnly/*/type`                 | Not interpreted                                             | P; do not declare without proof that “1=user, 2=assistant”                                                                                                                          |
| `/fullConversationHeadersOnly/*/serverBubbleId`       | Not interpreted                                             | P: not rewritten merely because it coincides with a local ID                                                                                                                        |
| `/fullConversationHeadersByBubbleId`                  | Object, keys are bubble IDs                                 | Keys remapped; known ID fields of the nested object remapped                                                                                                                        |
| `/conversationMap`                                    | Object, keys are bubble IDs                                 | Likewise                                                                                                                                                                            |
| `/bubbles`                                            | Object, keys are bubble IDs, if that variant is encountered | Likewise; do not confuse with the top-level `ExportObject.bubbles`                                                                                                                  |
| `/originalFileStates`                                 | Object, keys are original file URIs                         | URI keys are preserved; they are not turned into paths on the new machine                                                                                                           |
| `/originalFileStates/<uri>/firstEditBubbleId`         | String                                                      | Remapped by this composer’s bubble map                                                                                                                                              |
| Other fields, including signatures and internal state | Unknown                                                     | P: preserve; do not strip them to work around missing blobs                                                                                                                         |

`COMPOSER_BODY_POINTERS` declares `/composerId`; the shared `remapJsonObject` additionally applies bubble pointers and known keyed maps to the JSON objects it processes. This is a targeted remap, not a recursive replacement of every similar-looking string.

#### Bubble-body fields the code understands

| JSON path                                             | Representation                 | Behaviour                                                                                                |
| ----------------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `/composerId`                                         | String or absent               | If set before remap, must match the owner; the resulting field receives the new composer ID              |
| `/bubbleId`                                           | String or absent               | If set, must match the bubble record; remapped. An absent field is not synthesised by the current code   |
| `/nextBubbleId`                                       | String, if set                 | Exact match remapped by the map; an unknown value is not replaced as a substring                         |
| `/previousBubbleId`                                   | String, if set                 | Likewise                                                                                                 |
| `/images`                                             | Array; null or absence allowed | Attachment UUIDs are extracted separately                                                                |
| `/images/*/uuid`                                      | UUID string                    | Image-file identifier; **not remapped**. A non-string or missing uuid is skipped by the current function |
| `/_v`                                                 | For example, 3 in fixtures     | P; there is no separate full versioned bubble codec in the project                                       |
| `/text`                                               | Message text in fixtures       | P: never replace UUID substrings inside user text                                                        |
| `/serverBubbleId`                                     | Not interpreted                | P, not remapped                                                                                          |
| Image dimensions, model, tool payload, unknown fields | Not interpreted                | P: in full inside the original JSON; do not promise file restore from this metadata                      |

Checks: `test/remap.test.ts`, `test/conversation.test.ts`, `test/transfer.sqlite.test.ts`. `inspectComposer` rejects JSON `null`, arrays, and other non-object bubble payloads so that a broken chat cannot abort an independent valid chat during partial recovery.

#### conversationState: known fragment of the wire schema

| Level         | Field                                                                            | What is known                                                                                                                                          |
| ------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| JSON          | `conversationState`                                                              | Prefix `~`; the remainder is decoded as canonical base64, 16 MiB limit                                                                                 |
| Protobuf wire | `field=1,3,6,7,8,11,13`, wire 2, length 32                                       | Blob ids for prompt roots, todos, summary, plan, turns, and summary archives. Field 8 is the turn list Cursor hydrates on continue                     |
| Protobuf wire | `field=12,31` map values and `field=15` file-state `content` / `initial_content` | 32-byte values are blob ids                                                                                                                            |
| Protobuf wire | `field=16` subagent state                                                        | Nested `ConversationStateStructure`, walked the same way                                                                                               |
| Protobuf wire | Other top-level fields, including `field=18` read paths                          | Walked for wire validity. A 32-byte string is not a blob id                                                                                            |
| Blob value    | Turn, user message, summary archive                                              | `user_message`, `steps`, shell command/output, `text_blob_id`, `rich_text_blob_id`, `conversation_state_blob_id`, and summary message ids are required |
| Blob value    | Other parsed records                                                             | A 32-byte field is copied when that `agentKv:blob` exists. A miss is not counted incomplete                                                            |

`WireField` in `conversation-state.ts` has `field`, `wire`, `offset`, `bytes`. `offset` is the start of the payload after the tag and length; it is a local parser representation, not Cursor’s SQL schema.

`~` by itself encodes empty bytes; it is **not proof** that the conversation is a draft. Do not assign “human” names to unknown protobuf fields without a fixture and confirmed behaviour. Encoding: [Protocol Buffers](https://protobuf.dev/programming-guides/encoding/).

### 7.5 composerHeaders

The table is optional. `value` is JSON `ComposerHeader`; some fields are also projected into SQL columns. The code reads the ID from JSON and does not use the selected SQL column `composerId` as a fallback. A contradiction between SQL ID and JSON ID should therefore be treated as suspicious; the current reader does not check that equality.

| SQL column      | Required by the adapter | Value on write / read                                                                                                |
| --------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `composerId`    | Yes                     | ID of the new copy, UPSERT conflict target                                                                           |
| `value`         | Yes                     | Full JSON of the bound header, including unknown preserved fields                                                    |
| `workspaceId`   | No                      | On write, `workspace.storageId`; on read, fills a missing `workspaceIdentifier.id`                                   |
| `createdAt`     | No                      | `finiteInt(header.createdAt, Date.now())`                                                                            |
| `lastUpdatedAt` | No                      | `finiteInt(header.lastUpdatedAt, created)`                                                                           |
| `isArchived`    | No                      | `header.isArchived ? 1 : 0`                                                                                          |
| `isSubagent`    | No                      | **Current extension mapping:** `header.isBestOfNSubcomposer ? 1 : 0`; equivalence to native notions is not confirmed |
| `recency`       | No                      | Written as the computed `updated`, not a separate header field                                                       |
| `checkpointAt`  | No                      | `finiteInt(header.conversationCheckpointLastUpdatedAt, null)`; `NULL` when absent                                    |

`finiteInt` returns the fallback for null, undefined, empty string, or a non-numeric result; otherwise it does `Math.trunc(Number(value))`. Time fields are used as JavaScript timestamps, yet the official unit contract of every private column is not established. SQL INSERT includes optional columns only when they are present in the live schema. Unknown extra columns are neither filled nor listed in the UPSERT SET.

Source: `db.headerUpsertSql`, `schema.KNOWN_HEADER_WRITE_COLS`, `types.ComposerHeader`.

#### JSON ComposerHeader: every named field of the TypeScript interface

| Field                                 | Type       | Behaviour                                                                                                      |
| ------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------- |
| `composerId`                          | `string`   | Required ID; remapped on import                                                                                |
| `name`                                | `string?`  | Human-readable name; used in picker, filename, and log. Preserved; an explicit empty name differs from absence |
| `subtitle`                            | `string?`  | Extra description in the picker; P                                                                             |
| `createdAt`                           | `number?`  | P in JSON, source of SQL `createdAt`                                                                           |
| `lastUpdatedAt`                       | `number?`  | P in JSON, source of SQL `lastUpdatedAt` / `recency`                                                           |
| `isArchived`                          | `boolean?` | P, source of the SQL column of the same name                                                                   |
| `isBestOfNSubcomposer`                | `boolean?` | P, current source of SQL `isSubagent`                                                                          |
| `conversationCheckpointLastUpdatedAt` | `number?`  | P, current source of SQL `checkpointAt`                                                                        |
| `workspaceIdentifier`                 | Object?    | Replaced with a binding to the target workspace                                                                |
| Any other field                       | `unknown`  | Index signature preserves extensibility; P, do not document invented semantics                                 |

#### workspaceIdentifier and URI

| Field                        | Behaviour                                                                                                                                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspaceIdentifier.id`     | Project storage ID                                                                                                                                                                                      |
| `workspaceIdentifier.uri`    | Serialised URI; matching supports observed forms through a helper                                                                                                                                       |
| `uri.scheme`                 | For example `file` or `vscode-remote`; part of identity                                                                                                                                                 |
| `uri.authority`              | SSH authority and other authorities; part of identity, not a pretty display label                                                                                                                       |
| `uri.path`                   | URI path, not a universal local fsPath                                                                                                                                                                  |
| `uri.query`, `uri.fragment`  | Participate in `workspaceKey`; absence is normalised to an empty string                                                                                                                                 |
| `uri.$mid`                   | Compatible serialised service field; bind writes `1`                                                                                                                                                    |
| `uri.fsPath`, `uri.external` | Allowed by the type; bind adds them for `file:`. The current matcher reads scheme, authority, path, query, and fragment, not a fallback `external`; identity must not be recovered from a display label |

`workspaceKey` encodes the array `[kind, scheme, authority, path, query, fragment]`. `kind` is `folder` or `workspace`. Projects `ssh-remote+host-a:/repo` and `ssh-remote+host-b:/repo` have different URI keys. The current `matchesWorkspace` first accepts a match of `workspaceIdentifier.id` with storageId and only then checks the URI; a contradictory URI with a matching storageId is not rejected today. A convenient SSH host name is derived separately and does not change the key.

#### Header merge order

`resolveComposers`: workspace ItemTable → workspace header table → global header table with workspace filter → global legacy blob with filter. `mergeHeaders` chooses by rank `table=3`, `blob=2`, `workspace=1`, `selected=0`; the last value exists in the type and map, but the current resolver does not add selected as a separate catalogue. At equal rank the first encountered header is kept.

If the winning record **does not contain** `name`, a non-empty name from a lower source may be used as fallback. If `name === ''`, the empty name is kept. `empty-state-draft` is excluded. Headers are unique by composer ID, not by name.

### 7.6 System schema and temporary tables

These are not additional permanent user chat tables.

| Object / field                 | Meaning                         | Use by the extension                                                                       |
| ------------------------------ | ------------------------------- | ------------------------------------------------------------------------------------------ |
| `sqlite_schema.type`           | Object kind                     | Reads; distinguishes table/view                                                            |
| `sqlite_schema.name`           | Object name                     | Reads only the allowlist of three tables                                                   |
| `sqlite_schema.tbl_name`       | Owner table                     | The current detector does not use it                                                       |
| `sqlite_schema.rootpage`       | Root page                       | Not used                                                                                   |
| `sqlite_schema.sql`            | Object DDL                      | Not used in the runtime detector; useful in a manual schema audit                          |
| `PRAGMA table_info.cid`        | Column position in the output   | Service field                                                                              |
| `PRAGMA table_info.name`       | Column name                     | Checks presence of required columns                                                        |
| `PRAGMA table_info.type`       | Declared type                   | Obtained, not strictly validated                                                           |
| `PRAGMA table_info.notnull`    | NOT NULL constraint             | Used when refusing an unknown required column                                              |
| `PRAGMA table_info.dflt_value` | SQL default                     | Checks that a default exists                                                               |
| `PRAGMA table_info.pk`         | Position in the PK, 0 if not PK | Obtained; the current detector does not check it fully                                     |
| `temp.cct_resource_guard.ok`   | INTEGER, CHECK(ok=1)            | Temporary table of one write connection, to detect mismatched resource bytes before COMMIT |
| `temp.cct_cas_guard.ok`        | INTEGER, CHECK(ok=1)            | Metadata CAS: a failed CHECK abort rolls back the open transaction before COMMIT           |

Documentation: [schema table](https://sqlite.org/schematab.html), [table_info / table_xinfo](https://sqlite.org/pragma.html#pragma_table_info). `table_info` does not list every hidden or generated column; for a full DDL audit use `table_xinfo`, indexes, and triggers. Do not run Cursor schema migrations from the extension.

---

## 8. Export ZIP contract

Version 4 is the only user-facing archive format. There is no legacy reader, migration or monolithic export JSON.

| Entry                                        | Purpose                                                                      |
| -------------------------------------------- | ---------------------------------------------------------------------------- |
| `manifest.json`                              | Format/version, producer, optional source/summary, counts and inventory hash |
| `inventory.ndjson`                           | One entry per data file: relative path, uncompressed bytes, SHA-256 and kind |
| `catalog/000001.ndjson`                      | Ordered chat descriptors using generated ordinal paths                       |
| `chats/000001/header.json`                   | One chat header                                                              |
| `chats/000001/composer.json`                 | Composer fields and conversation layout                                      |
| `chats/000001/conversation/*.ndjson`         | Ordered conversation-header records                                          |
| `chats/000001/bubbles/*.ndjson`              | One bounded bubble envelope per line                                         |
| `chats/000001/resources/*.ndjson`            | Resource metadata and blob references                                        |
| `blobs/<first-two-hash-digits>/<sha256>.bin` | Original binary resource bytes, deduplicated by hash                         |

NDJSON parts target 16 MiB; a larger individual permitted record gets its own part. Limits: 32 MiB per JSON record / SQLite value; 1 MiB manifest; 250,000 ZIP entries; JSON depth 64; 100,000 object properties per record. These are explicit bounds, not a guarantee that memory equals the input record size. Parsed objects, strings, buffers, maps and SQLite caches add overhead. The total archive may exceed 1 GiB. ZIP staging, temporary indexes, backups and databases also require free disk space.

Export uses a unique sibling staging directory and a unique `.partial` ZIP. The final archive is published by rename only after packaging succeeds. Import verifies entry hashes as it extracts and checks the inventory before planning writes. File paths use generated ordinals, never chat titles. Binary resources are streamed; small JSON values use ordinary bounded parsing.

---

## 9. Partial recovery and completeness

`cursorChatTransit.import.allowPartial=false`: an incomplete or unusable chat blocks import before writes. `true`: valid history with missing supported blobs, images, or plans may be transferred as history-only; an unusable chat is skipped; independent complete chats are kept.

History-only is an extension report, **not an established native read-only mode of Cursor**. The existing code cannot promise that such a conversation will continue. A chat that looks readable still does not prove completeness of agent state.

For resources present in the archive, verify byte length, hash and SQLite storage class. Resource paths and aliases must be safe basenames. Missing dependencies remain explicit; target availability alone does not prove the source export was complete.

`originalFileStates` is not a backup of the working tree. Import does not transfer every version of the original files, the checkpoint graph, arbitrary external URIs, or the contents of a remote git repository.

---

## 10. Read-only inventory of an unknown schema

The following queries are for investigating a new layout; a result does not mean that writes are automatically allowed:

```sql
SELECT type, name, tbl_name, sql
FROM sqlite_schema
WHERE name NOT LIKE 'sqlite_%'
ORDER BY type, name;

SELECT m.name AS table_name, p.cid, p.name AS column_name,
       p.type, p."notnull", p.dflt_value, p.pk, p.hidden
FROM sqlite_schema AS m
JOIN pragma_table_xinfo(m.name) AS p
WHERE m.type = 'table'
ORDER BY m.name, p.cid;

PRAGMA index_list('composerHeaders');
PRAGMA index_list('cursorDiskKV');
PRAGMA foreign_key_list('composerHeaders');
```

Run them through `sqlite3 -readonly` with the same isolated init file the extension uses. Do not include chat-row values in a diagnostic report. Names of unknown tables and columns may be listed as discovered or unsupported; purpose is unknown until investigated.

Do not replace an entire live global `state.vscdb` with an old backup over a running Cursor: that would also roll back unrelated changes. Release acceptance needs real Cursor checks after a full restart: open the imported chat, open an image, send a new message; repeat for a local and an SSH workspace. The stock SQLite fixtures do not prove that.

---

## 11. Open work

On 2026-09-29 the maintainer reported that newly transferred chats worked after import, including continued use. This is a successful manual smoke result, not an automated cross-version matrix; the exact Cursor build, operating system matrix and resource variants were not recorded in that report.

The following are limitations or further validation work, not a claim that the reported successful transfer failed:

- Batch workspaces
- Pinned-state fixture
- A repeatable Cursor continuation test matrix, including imported attachments and Remote SSH
- Output-panel reveal from a hidden panel, a modal, or during import (API wired; host proof pending)
- Recursion into blob payloads, checkpoints, and `originalFileStates` file bytes
- Records larger than 32 MiB are deliberately unsupported; split-format streaming does not remove this per-record limit
- Persisted import receipts exist; automatic resume of a partial workspace transaction is not implemented
- A working sidebar list of native “open this chat” links
- Full SSH/Windows/macOS host matrix beyond CI sqlite jobs

A same-basename plan file with different bytes remains `RESOURCE_CONFLICT`. The policy “changed snapshot → separate chat” does not promise overwrite of that plan file.

---

## 12. Sources

These inform wording and host constraints. They do not certify the drawing or claim a universal “FAANG naming standard”.

- [Microsoft word-choice checklist](https://learn.microsoft.com/en-us/style-guide/checklists/word-choice-checklist): “If you mean the same thing, use the same word.” This supports a stable action vocabulary, not replacing the ordinary English verb “transfer” with the product name.
- [VS Code Activity Bar](https://code.visualstudio.com/api/ux-guidelines/activity-bar): “Use an icon that matches the default Activity Bar item icon style.” This is the primary host-specific rule.
- [VS Code Webview API](https://code.visualstudio.com/api/extension-guides/webview#theming-webview-content): use editor theme variables and test theme variants.
- [VS Code Testing Extensions](https://code.visualstudio.com/api/working-with-extensions/testing-extension): Extension Host tests are separate from ordinary Node tests.
- [Apple App icons](https://developer.apple.com/design/human-interface-guidelines/app-icons): simple recognisable forms; Apple-specific app masks and materials are not a VS Code requirement.
- [Material Icons Guide](https://developers.google.com/fonts/docs/material_icons): simple modern geometric forms at small sizes. The custom Transit mark is not claimed to be an official Material Symbol. See also [Material 3, designing icons](https://m3.material.io/styles/icons/designing-icons).
- [SQLite WAL](https://sqlite.org/wal.html) and [ATTACH](https://sqlite.org/lang_attach.html): operations on several databases are not one atomic transaction as a set.
- [SQLite Online Backup API](https://sqlite.org/backup.html): a live database needs a consistent backup, not a copy of only the main WAL file.
- [MIT license](https://opensource.org/license/mit): copyright and permission notices must be retained in copies or substantial portions of the Software.
- [VS Code modal dialogs](https://code.visualstudio.com/api/ux-guidelines/notifications#modal-dialog): avoid chaining extra confirmations before a host action that already confirms.

The exact bubble shape, spacing, and wording are product decisions informed by these sources. No claim of official Apple or Google approval is made.

## Picker ordering and operational settings

`activity.ts` owns valid millisecond timestamps and immutable chat ordering. Chat rows use descending `lastUpdatedAt`, falling back to `createdAt`; ties use creation time and then the composer ID. Invalid/absent dates sort last. IDs are never interpreted as timestamps. For picker reads only, `db-read.ts` recovers real timestamp columns when a table header's JSON lacks usable dates. Export/verification reads do not add these presentation-only dates, preserving snapshot fingerprints. No chat is hidden solely for lacking a title or date.

`picker.ts` applies current-workspace priority, then explicit location ranks: local, SSH, containers, WSL, other, unidentified. Within a group, DB/WAL activity descends, followed by deterministic tie-breakers. `workspace-presentation.ts` owns readable labels, not storage identity. Separators use a location class rather than one section per SSH host. Duplicate-looking entries are disambiguated, never merged or deleted. Sorting happens before the picker opens, with no background reordering.

`extension-settings.ts` reads explicit user values from `cursorChatTransit`. Repository overrides cannot redirect local paths, change timeouts or enable partial recovery. The operation context carries `timeoutMs`, `busyTimeoutMs` and `plansDir` into reads, writes, snapshots and verified backups. The deadline applies to each SQLite child process, not to a whole multi-step transfer. Busy waits are bounded SQLite connection settings, separate from the process deadline. The setting defaults remain 600 seconds and 5 seconds respectively; a diagnostic probe retains its own short deadline.

`file-uri.ts` formats native paths and escaped file URIs separately, including Windows drive letters and UNC hosts. Never replace URI identity with an `fsPath`, and never treat a remote project's POSIX path as a path on a Windows UI host.

## Progress and logging contract (2026-10-01 review)

`log-format.ts` formats every Output line as `[YYYY-MM-DD HH:mm:ss.SSS±HH:mm] [LEVEL] Message`. The clock is local to the extension host, the numeric offset is mandatory, and messages use sentence case. Structured field names and values retain their casing. `operation-log.ts` names phases in plain English and logs transitions, completion and five-second progress heartbeats. `output-ui.ts` also formats standalone error, quit and stale-lock messages, without a second prefix on already formatted operation lines. File/row events retain concrete paths, chat identity, KV keys and exact byte counts. This is a text format, not an OpenTelemetry dependency.

`ProgressModel` uses a monotonic clock. A stable `scope` identifies the measured work independently of its current display path. Extraction obtains its byte denominator in a bounded metadata pass over ZIP entries and measures all entries cumulatively. Packing measures source bytes. Validation measures inventory entries and NDJSON input parts. Preparation and post-write verification report resource counts. ETA is a rough current-step estimate after one second of observed advancement. Unknown totals explain why no estimate is available; a ten-second unchanged counter stops showing an ETA. Backup progress is not fabricated.

Blob payloads in the user-facing ZIP pipeline are loaded one at a time. The dependency graph retains bounded IDs/roles, not payloads; imports retain resource metadata paths, and exports write each loaded resource directly to staging. A role discovered later is parsed even if that digest was scanned earlier; missing optional candidates upgraded to required remain missing. Malformed known structured blobs produce an unsupported result. Generic scans still follow only candidates that exist: this is not a complete schema for every Cursor tool/step variant, and `complete` does not certify all future Agent continuation behavior.

`kv-session.ts` reads values through one read-only SQLite session per scan, avoiding one CLI launch per resource. A single SQL statement streams hex in lines no larger than about 2 MiB, then reconstructs one value up to the existing 32 MiB limit. SQLite storage class and bytes are preserved. Writers explicitly open writable sessions; no Cursor journal mode is changed.

Sources: [RFC 3339 §5.6](https://www.rfc-editor.org/rfc/rfc3339#section-5.6) permits a readability-oriented space separator; [OpenTelemetry Logs Data Model](https://opentelemetry.io/docs/specs/otel/logs/data-model/) separates timestamp, severity, body and correlation context. The concrete text delimiters and local-clock presentation are project choices.
