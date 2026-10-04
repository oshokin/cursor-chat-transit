# Architecture

Cursor Chat Transit copies chat snapshots between workspace storage entries in a local Cursor profile. It does not synchronize live conversations or implement Cursor's chat runtime. Storage support is based on inspected schemas and observed record structures, not an official Cursor API.

For setup, validation, packaging, and releases, see [Development](development.md). For picker statistics, settings, and troubleshooting, see [Usage](usage.md).

## Components

| Area             | Modules                                                                           | Responsibility                                                                 |
| ---------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Host integration | `extension*.ts`, `quit-cursor.ts`                                                 | Commands, native dialogs, settings, and application actions                    |
| Sidebar          | `sidebar-provider.ts`, `webview/`                                                 | Themed transfer status and a restricted action interface                       |
| Selection        | `picker.ts`, `activity.ts`, `workspace-presentation.ts`                           | Stable ordering, labels, identity, and disambiguation                          |
| Statistics       | `statistics.ts`, `statistics-picker.ts`, `extension-statistics.ts`                | Read-only analysis, native picker lifecycle, and operation logging             |
| Worker transport | `transfer-process.ts`, `transfer-worker.ts`                                       | Isolated work, incremental IPC events, and cancellation                        |
| Export           | `export-transfer.ts`, `export-bundle.ts`, `export-chat.ts`, `export-resources.ts` | Header resolution, consistent database reads, and archive creation             |
| Import           | `import-bundle*.ts`, `import-batches.ts`, `import-cleanup.ts`                     | Validation, preparation, bounded writes, and interrupted-import reconciliation |
| Archive          | `bundle-*.ts`, `ndjson-io.ts`                                                     | Format validation, bounded records, indexes, and ZIP I/O                       |
| Database access  | `sqlite*.ts`, `read-transaction.ts`, `db*.ts`, `schema.ts`                        | Asynchronous SQLite processes, read views, schema checks, and SQL operations   |
| Resources        | `dependencies.ts`, `resource-*.ts`, `attachments.ts`, `plans.ts`, `canvases.ts`   | Reference discovery and byte-preserving resource transfer                      |
| Receipts         | `journal*.ts`, `import-policy.ts`, `import-reconcile.ts`                          | Snapshot identity, pending work, and repeat-import decisions                   |
| Observability    | `operation-log.ts`, `log-format.ts`, `transfer-events.ts`, `progress-model.ts`    | Structured facts, readable logs, and measured progress                         |

Sources compile from `src/` to `out/`. The sidebar client compiles from `webview/` to `resources/sidebar-client.js`. Small object-based helpers support fixtures; they do not provide an alternative monolithic JSON file-import path.

## Storage and identity

A storage entry pairs one workspace database with the global database from the same local Cursor profile:

| Object                            | Location or representation                                  |
| --------------------------------- | ----------------------------------------------------------- |
| Global database                   | `User/globalStorage/state.vscdb`                            |
| Workspace database                | `User/workspaceStorage/<storageId>/state.vscdb`             |
| Workspace identity                | `User/workspaceStorage/<storageId>/workspace.json`          |
| Chat images                       | Workspace storage's `images/` directory                     |
| Plans                             | Configured plans directory, defaulting to `~/.cursor/plans` |
| Canvases                          | Workspace-associated Cursor project storage                 |
| Transfer archive                  | User-selected `*.cursor-chat.zip`                           |
| Receipts and pending import state | Extension-owned local storage                               |

The local storage root, project URI, and archive location are separate concepts. An SSH project URI does not imply a remote chat database. `extensionKind: ["ui"]` keeps the extension on the local side of the editor.

`workspaceKey()` includes the workspace kind and URI scheme, authority, path, query, and fragment. A readable project name is never a storage key. Duplicate-looking storage entries remain separate. A configured user-data directory is authoritative; missing databases do not cause a silent switch to another profile.

## Cursor storage contract

The adapter inspects the actual schema before operating. A Cursor version string alone does not establish support.

| Table             | Relevant columns                                                              | Use                                                      |
| ----------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------- |
| `ItemTable`       | `key`, `value`                                                                | Workspace lists and global header lists                  |
| `cursorDiskKV`    | `key`, `value`                                                                | Composer bodies, message records, and conversation blobs |
| `composerHeaders` | `composerId`, `value`; optional workspace, date, archive, and recency columns | Header metadata when a supported table exists            |

`composerData:*`, `bubbleId:*`, and `agentKv:blob:*` are keys in `cursorDiskKV`, not tables. `conversationState` is a field inside composer JSON.

### Header resolution

`resolveComposers()` combines:

1. The workspace `ItemTable` entry `composer.composerData`.
2. A workspace `composerHeaders` table, when present.
3. Matching rows from the global `composerHeaders` table.
4. Matching entries from the global `composer.composerHeaders` value.

Headers are deduplicated by composer ID. Table metadata takes precedence over global list metadata, which takes precedence over workspace list metadata. A missing title can inherit a known nonempty title from a lower-priority source; an explicitly empty title remains empty. The `empty-state-draft` sentinel is excluded.

Global header enumeration gives an explicit storage ID priority over the URI: a header bound to storage A is not also listed in storage B just because their project paths match. URI matching remains a fallback for headers with no storage ID. Explicit workspace-local lists remain part of the union and can legitimately share chats. Import reconciliation retains its separate logical-workspace and conflict rules; listing changes do not weaken write conflict checks. The Current label uses the host-provided workspace storage path when available. URI-only fallback marks a current row only when exactly one entry matches; a reused path never marks several storage generations as current. Selection dates may be recovered from header-table columns for display; those presentation fields are not injected into export fingerprints.

### Composer and message records

| Record or field                    | Handling                                                                                                        |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `composerData:<composerId>`        | Read a bounded composer JSON value; remap known identity fields for a new copy                                  |
| `fullConversationHeadersOnly`      | Preserve conversation order and references to stored messages                                                   |
| `bubbleId:<composerId>:<bubbleId>` | Read by an indexed key range; preserve payload text and remap known IDs                                         |
| `conversationState`                | Inspect supported `~`-prefixed protobuf state to discover blob dependencies                                     |
| `agentKv:blob:<sha256>`            | Preserve bytes and SQLite storage class; verify content and references                                          |
| `isNAL`                            | Read as an explicit storage-format hint for statistics; never change it to bypass Cursor's compatibility checks |

The dependency reader supports the observed conversation-state representation in composer versions 13 through 18. This is a partial wire-format reader, not a general Cursor codec. Unknown structured state remains unsupported. `~` alone encodes empty bytes and is not proof that a chat is an empty draft. `_v` does not distinguish legacy conversations from Agent conversations.

Known ID and URI fields are remapped structurally. Message text and arbitrary strings are not searched and replaced. Unknown preserved fields are not claimed to be understood. Plans are resolved through permitted basenames and configured directories, not arbitrary paths supplied by archive JSON.

## Export

1. Open an owned, read-only transaction on the global database and a short read transaction on the workspace database.
2. Resolve headers through those connections and apply the selection.
3. Close the workspace read view after header resolution.
4. Read selected composer bodies, messages, and supported conversation blobs through the same global read view. Stream records and resource files into private staging storage.
5. Record missing or unsupported data as explicit completeness issues.
6. Close the global read view before inventory hashing and ZIP compression.
7. Complete the archive using the validated staging data.

A read transaction provides one database view without making a full database copy. The workspace and global databases, and external attachment files, are not one atomic snapshot. In WAL mode, writes can continue while a reader is active, but checkpoint progress may be delayed. Other journal modes retain SQLite's normal locking behavior. The extension does not change journal mode or force checkpoints.

## Import

1. Acquire the extension's process lock for the target global database.
2. Extract the archive incrementally into private temporary storage. Reject unsafe paths, duplicate members, invalid hashes, unsupported formats, and oversized records.
3. Build a temporary SQLite index and calculate canonical snapshot fingerprints. Resolve repeat-import decisions and resource conflicts before writing chat data.
4. Record pending identities and expected hashes in the private journal.
5. Remap known IDs and prepare message/resource rows in a private SQLite database, outside Cursor's write transactions.
6. Install prepared rows in bounded transactions, normally at most 128 rows or 8 MiB. A permitted single value can exceed the batch budget, up to the 32 MiB value limit.
7. Publish composer/global headers, bind the chat into the workspace, verify the written data, and save the receipt.

Global and workspace commits are separate transactions. The journal records durable progress across that boundary. Cancellation or failure after a durable batch leaves pending state for reconciliation. Retry can remove verified unpublished message rows only when their identity, recorded hashes, and current bytes match. Changed or unknown rows are preserved; shared blobs are not deleted indiscriminately.

Import does not create a full database backup or restore the entire profile automatically. The journal supports known interrupted-import states, not general undo. No JSON parsing, directory enumeration, or per-message journal update belongs inside a main-database batch transaction.

Owned SQLite children stop on cancellation, timeout, or worker disconnect. Connection cleanup waits for child exit before releasing the operation lock. Clearing a stale extension lock does not remove SQLite locks or justify deleting database, WAL, or SHM files.

## Repeat-import policy

Snapshot identity is independent of titles and remapped destination IDs. An unchanged previously imported snapshot in the same destination is skipped. A changed source snapshot creates a separate chat. Continuing or renaming the destination chat does not authorize replacement.

A deleted imported chat can be restored as a new independent copy when its receipt and remaining state can be verified. Leftover rows are not treated as a reusable chat. Unfinished pending work is reconciled before a new copy is created. Clearing the extension's receipt storage removes this history.

Snapshot comparison ignores known presentation-only changes such as `grouping.textPreview`. It does not ignore arbitrary message or resource changes. A plan filename collision with different bytes remains a resource conflict even when the chat itself would receive a new ID.

## Archive contract

Format version 4 is the only file format read and written by this build. An archive is a ZIP directory containing a manifest, catalog parts, per-chat headers and composer fields, conversation/message parts, inventory data, and content-addressed resources. There is no custom JSON parser and no monolithic JSON import fallback.

| Limit                   | Value     |
| ----------------------- | --------- |
| Manifest                | 1 MiB     |
| NDJSON part target      | 16 MiB    |
| Single JSON record      | 32 MiB    |
| Single SQLite value     | 32 MiB    |
| JSON nesting            | 64 levels |
| Keys in one JSON record | 100,000   |
| ZIP entries             | 250,000   |

A record larger than the part target occupies its own part within the record limit. The total archive can exceed 1 GiB. Readers use ordinary `JSON.parse` for individual bounded values; NDJSON framing enforces byte limits. Blob payloads are processed one at a time. Dependency traversal retains identifiers and roles, not every blob body.

ZIP extraction validates paths and entry metadata before installation. Resource bytes are verified and existing files are reused only when their content matches. Format and safety constraints remain active during recovery. An incomplete import pauses after staging its plan and before publishing Cursor data. The worker sends only bounded counts and examples over IPC; the extension requests consent for this operation. Cancellation while waiting releases the worker and its locks. Reconciliation validates prior pending records and may update private receipts during inspection; cleanup of unpublished Cursor rows is deferred until the decision boundary has passed.

## On-demand statistics

The workspace picker automatically checks history before publishing its initial list; the current workspace is retained and the Show all / Hide empty toggle changes visibility without another scan. Each picker also has a metadata statistics button; the chat picker adds a checked-selection action. While running, that button becomes **Stop analysis**, the native busy indicator is active, and the title shows completed rows. Input remains enabled. No modal progress dialog interrupts selection.

`statistics-picker.ts` preserves filter text, selected IDs, active items, scroll position, and original order when replacing row details. Updates are coalesced on a 100 ms timer. Accepting or closing the picker cancels analysis immediately and waits for worker cleanup before the caller starts its next operation. Late results cannot update a disposed picker. A repeated click while stopping does not launch another worker.

The worker scans rows sequentially:

- **Workspace counts:** read global header metadata once per database for that scan, then resolve each workspace with the same merge rules used by the chat list. Each workspace read view is short-lived. Count titled and untitled IDs separately; no message bodies or blob graph are read.
- **Chat statistics:** read one bounded composer value at a time. Probe its byte length in the same read transaction before loading it into Node. Count recognized user entries in `fullConversationHeadersOnly`, or a supported inline `conversation` array. Duplicate bubble references count once; inconsistent or unknown entries make the count unavailable. Do not scan unrelated message bodies or blobs.

An explicit `isNAL: false` yields **Legacy format — may not continue**. An explicit `true` yields **Agent format**. Other values yield **Format unknown**. These labels report observed storage fields, not a promise of runtime compatibility. Analysis does not infer support from `_v`, fabricate conversation state, or migrate chats.

Errors are isolated to the affected row and logged with its database path and identity. A failed read is not displayed as zero. A cancelled scan keeps completed results and marks unprocessed rows **Not analyzed**. A new scan refreshes all rows; reopening the picker starts with no cached results. No persistent cache or new setting is needed.

Global header metadata is a scan-local snapshot. Each workspace/chat is read separately, so statistics are not a profile-wide atomic snapshot and do not track concurrent edits live.

## Progress and logs

The sidebar reports four export stages or five import stages, current work, and elapsed time. `ProgressModel` uses a monotonic clock. Estimates require a measured denominator and observed progress; otherwise the remaining-time line is omitted. Estimates describe the current stage. A stalled measured counter stops producing an ETA rather than claiming an exact completion time.

Operations use `[YYYY-MM-DD HH:mm:ss.SSS±HH:mm] [LEVEL] Message`. The timestamp is local to the extension host and includes its numeric offset. An operation ID correlates events. Messages use sentence case; structured field names retain their own casing. Exact byte counts appear alongside readable binary units.

File and record events identify the action, path, chat ID/title when available, duration, and error code. Payload text, SQL, and authentication data are excluded. Statistics use the same Operations channel with their own start and terminal events. Diagnostics uses a native dialog with **Copy report** and **Close**.

## Configuration and release boundaries

Settings are read from explicit user values. Repository settings cannot redirect local storage or enable partial recovery. Query deadlines and busy-handler waits are independent and are captured when an operation starts. There is no whole-transfer deadline. Diagnostic probes use their own short internal limits.

Local release preparation updates version files and the changelog only when explicitly requested. GitHub validates the chosen commit, builds a VSIX, and publishes it with checksums after release gates succeed. Registry publishing is not part of the workflow. See [Development](development.md) for first-release and retry behavior.

## Scope and validation

The test suite covers format handling, identity, repeat imports, recovery, SQLite contention and cancellation, picker state, statistics, logging, and packaging. Synthetic fixtures and a VS Code host smoke test do not prove continuation support in every Cursor build. Release acceptance includes opening imported chats in Cursor, checking supported attachments, and trying a new message in both local and remote workspace scenarios.

The extension does not transfer the project tree, recreate unavailable server state, guarantee continuation of legacy chats, vacuum Cursor databases, or delete unidentified workspaces.

## Design references

- [VS Code Quick Picks](https://code.visualstudio.com/api/ux-guidelines/quick-picks) and [QuickPick API](https://code.visualstudio.com/api/references/vscode-api#QuickPick): native selection, actions, busy state, and scroll preservation.
- [Apple progress indicators](https://developer.apple.com/design/human-interface-guidelines/progress-indicators) and [Material progress](https://m1.material.io/components/progress-activity.html): visible activity without inventing a percentage.
- [SQLite isolation](https://sqlite.org/isolation.html) and [WAL](https://sqlite.org/wal.html): read views, concurrent writes, and checkpoint constraints.
- [Google code review guidance](https://google.github.io/eng-practices/review/reviewer/looking-for.html): understandable design and avoiding unnecessary generalization.
- [Protocol Buffers encoding](https://protobuf.dev/programming-guides/encoding/): wire-format primitives; it does not document Cursor's private schema.
- [RFC 3339](https://www.rfc-editor.org/rfc/rfc3339#section-5.6): timestamp structure and an explicitly permitted space separator for readability.

The extension's labels and behavior are product choices informed by these references, not a claim of Apple, Google, or Microsoft certification. The MIT license retains the inherited notice and the notice for subsequent Cursor Chat Transit work.

## Checked selection and workspace filtering

`chat-health.ts` reuses `readChatForExport()` with a metadata-only sink. Omitting the spill directory makes resource reading validate bytes without writing temporary resource files or an archive. Message bodies are processed one at a time; only IDs, types, and the bounded conversation index are retained. Dependency frontiers use up to 32 keys, with a 4 MiB payload budget; a single larger permitted record is read alone. Protocol lines remain chunked and the 32 MiB record limit is unchanged. Inspection does not compute unused content hashes. Export still computes all hashes and verifies its archive inventory. The source database is read through an owned read-only view.

A chat passes source checks only when its supported conversation index references present message records, identities and message types agree, and the export reader reports no missing supported resources. Unsupported and ambiguous layouts are not automatically selected. Empty visible lists with leftover messages or nonempty state are unknown, not empty. Missing bodies with orphan messages are incomplete, not absent history. Referenced canvases without a resolvable canvas directory count as missing resources.

`chat-presence.ts` implements a cheaper workspace-only check. An indexed message-existence query retains history without loading any message payload. If no message exists, a bounded composer read distinguishes proven empty/missing data from references, resources, unknown state, and unsupported layouts. The scan never walks blob graphs or opens attachment files. To prove a workspace empty, every resolved chat is checked; when any chat must be retained, the presence scan stops early. One read view covers at most 32 chats and is then released. A workspace is hideable only when every resolved chat is confirmed empty or has neither a body nor remaining messages. An error or unknown/incomplete chat keeps it visible. Filesystem project-path existence is not a deletion or filtering criterion. These are view decisions; no storage is removed. Filter state lasts only for the current picker and can be reversed without another scan.

Filtering and bulk selection apply only after the worker finishes. Cancelled or failed runs do not apply partial changes. Per-row failures stay visible and are not selected. Checkbox state is compared with the state at the start of the scan; user changes win. Empty group separators are removed after filtering. Operations logs record both the checks and the action actually applied.

The source-data result is time-bounded evidence, not a destination compatibility or continuation certificate. Actual export/import validation remains authoritative.

## Icon assets

`resources/marketplace.svg` is the editable source for the transparent 256 × 256 RGBA `marketplace.png`. The mark has no background rectangle. Its blue-to-teal stroke is sized for the Extensions list, while the activity-bar version uses the same geometry in `currentColor` at a thinner 24-pixel stroke weight. Import/export/diagnostic icons share a 1.5-pixel rounded stroke on a 24-pixel grid. Picker actions use native ThemeIcons.

Rasterize the SVG with an SVG renderer that preserves alpha, such as resvg. Inspect the mark at 24, 48, and 128 pixels against dark, light, and selected-row backgrounds. Do not bake a particular editor theme into the PNG.

## Bounded file concurrency

Inventory checksums and ZIP source metadata use at most `min(4, os.availableParallelism())` independent reads. Results are consumed in input order. Every started task settles before failure escapes or staging cleanup starts. No unbounded `Promise.all`, cross-chat write parallelism, database-mode change, or persistent payload cache is introduced. Import validation and post-write verification remain mandatory. See [performance measurements and cleanup design](performance-and-cleanup.md).

## Addressed blob repair

Import can repair a narrowly defined representation error: an existing SQLite TEXT cell contains the hexadecimal spelling of the incoming BLOB. Repair requires valid hex, matching decoded length, and a SHA-256 matching both the incoming checksum and the `agentKv:blob:` address. Other storage-class or content conflicts remain conflicts.

Preflight checks every resource before applying repairs. Its repair queue holds identifiers and comparison metadata, not resource bodies. Each repair rereads one bounded value, checks it against the preflight hash, and uses a short transaction to update only the exact TEXT bytes observed. The stored BLOB is verified before commit. A changed row is preserved. This normalization can remain committed if subsequent chat preparation fails; it is not an all-or-nothing chat rollback.

A preflight resource conflict skips only that chat. Write-time conflicts and infrastructure failures stop the operation. Repeat imports reuse successful receipts. Attempt numbers include skipped chats.

## Partial history and management

`text-recovery.ts` implements a narrow, versioned annotation for exported partial history. `export-chat.ts` streams existing bodies first, then visits ordered missing IDs. Known-role previews or explicit gaps are emitted only when readable text survives. Only private staged composer metadata is rewritten; the source SQLite connection stays read-only. Full bodies, source order and roles are retained. Unknown roles and invalid formats remain unsupported. `cctTextRecovery` records counts, survives imports and re-exports, and makes the importer classify the chat as history-only.

The normal import pipeline remains responsible for integrity checks, resources, publication and receipts. Incomplete imports require per-operation consent. Recovery does not imply a usable Agent state or a verified native transcript renderer. The implementation has no Markdown writer and no separate recovery-copy command.

`managed-selection.ts` stores physical workspace/chat identities. `extension-manager.ts` owns native checkboxes, search, reversible view filtering, cached headers and actions. Parent selections are expanded to exact IDs before deletion confirmation; refresh clears selection. Unchecking a child of a selected workspace expands sibling selections. Empty and unavailable rows are hidden initially, not deleted. Show/hide toggles reuse metadata. Readable unknown formats are not treated as disposable.

`extension-managed-delete.ts` owns one confirmation and one ordinary operation scope. It sends a `delete-chats` job through `runTransfer`, publishes progress/results, and enables the existing Quit Cursor action after writes. It never calls Quit automatically. There is no persisted deletion queue, detached executor or process enumeration. Cancellation and notification dismissal follow the existing transfer lifecycle.

`chat-deletion.ts` orchestrates deletion. `deletion-ownership.ts` reads relevant discovered workspace metadata once and retains only selected identities. `deletion-sql.ts` owns transactional schema checks, selected-index revalidation and mutations. Known shared or unresolved owners are retained. Unsupported layouts, symlink database paths, relevant triggers and foreign-key dependencies stop the affected operation. Shared resources and workspace directories are never swept.

After `BEGIN IMMEDIATE`, selected global and workspace index rows are re-read and compared with preparation results. Unrelated current list data is retained when removing selected references. Global/workspace modifications use one attached transaction per workspace; attached WAL files do not provide crash atomicity as a group. The user must stop Cursor activity: index checks are not a lock on Cursor's in-memory cache or every other workspace.

Selected IDs are normalized in Sets. Temporary-ID inserts and indexed composer/message deletes use batches of at most 64 IDs. Every deletion batch is verified before commit. No full KV scan, resource sweep or parallel write fan-out is added. Failures and cancellation return earlier committed outcomes and stop later workspaces. A lost COMMIT acknowledgement is explicitly uncertain; a transport failure is also shown as an unknown final outcome. Neither is labelled a clean rollback.

`header-index.ts` builds storage-ID and URI-fallback buckets once per global snapshot, preserving source order and explicit-ID precedence. `WorkspaceHeaderReader` shares that index with statistics, catalogue and deletion ownership checks. The index stores metadata references, never message bodies, and is discarded at operation end. Bulk checks normalize selections, capture settings once, and use one statistics job per workspace under a shared cancellation/progress scope. An omitted chat list is resolved in that same worker; an empty list means no chats.

## Native manager and search

`extension-manager.ts` owns tree identity, root filtering, metadata caches, configuration invalidation, and command wiring. Read-only checks live in `extension-managed-check.ts`; deletion orchestration lives in `extension-managed-delete.ts`. Checks and deletion both use the existing operation and transfer worker. `ManagedNode` is the shared presentation model, not a separate representation of Cursor storage.

`managed-search.ts` owns a native Quick Pick with incremental results, focus retention, explicit cancellation, and selection-to-tree navigation. `workspace-catalogue.ts` reads headers in the worker. `WorkspaceHeaderReader` shares the same schema and identity resolution with statistics and caches global headers only for that scan. The catalogue never reads composer/message bodies. Completed header lists are reused by search and tree expansion until Refresh or a relevant configuration change. Failed cached reads are retried by a new search. A generation signal prevents stale results from revealing or updating a refreshed tree.

Search keeps compact header metadata proportional to the number of listed chats; it is not a constant-memory full-text index. One worker reads workspaces sequentially and releases each read view. Incremental UI updates are coalesced. Workspaces and chats use the same sorting functions as the transfer pickers. Concurrent clicks share one search picker.

## Operation lifetime and notifications

A notification Promise represents dismissal or action selection, not transfer completion. `notifications.ts` detaches result notices and catches both synchronous host failures and rejected action callbacks. Completed and no-result operations release progress and locks before notification dismissal. Import preflight with no available chats returns a negative decision immediately instead of opening an acknowledgement-only modal. A real recovery approval remains awaited before writes.

The transfer scope owns cancellation subscriptions and timers. Terminal results disable Cancel, and `withLock` clears process state in a final cleanup scope even if lock release rejects. Tree focus is independent of transfer lifetime. A configuration change invalidates manager metadata; changing the source profile also clears the selected workspace. Active worker jobs use their captured settings.

## Import and export boundaries

`import-bundle.ts` coordinates a transfer. `import-bundle-scan.ts` validates/indexes source chats and determines recovery availability; `import-bundle-resources.ts` resolves and verifies resources; `import-bundle-publish.ts` prepares and publishes chat rows; `import-bundle-reconcile.ts` handles deferred reconciliation. Shared plan shapes and small helpers live in `import-bundle-common.ts`. All modules use the existing journal and conflict checks; there is one write path.

`export-bundle.ts` owns the archive lifecycle, `export-chat.ts` reads a chat, and `export-resources.ts` walks its supported resource closure. The same small streaming sink contract supports archive writing and read-only inspection. The archive version stays unchanged; annotated partial text uses the same streamed record layout and integrity checks.
