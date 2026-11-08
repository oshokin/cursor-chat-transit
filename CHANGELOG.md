# Changelog

## 1.1.1

### Changed

- Show the storage id in the sidebar and in the export chat pickers. Chat descriptions keep the date and duplicate-title distinction; Cursor's edited-file subtitle is not treated as identity.
- Selecting chats with transfer issues skips a descendant whose check failed or is still unknown.
- Write and read only archive format 5. Format 4 and older JSON exports are rejected; export the chats again with this version.
- Require `visualization-html-v1` and `historical-artifacts-v1` in every format 5 manifest, in addition to the SQLite index and content-addressed blob capabilities. The private import journal is schema 3.

### Fixed

- Distinguish an unsupported native snapshot codec from corruption. A history-only renderer fallback is allowed only when that omission is explicit and the renderer dependency closure is present, supported, and complete. A corrupt native snapshot stays fatal, including during read-only inspection.
- Follow the Cursor 3.29.9 typed wrappers for read-success, truncated calls, and selected context. Traversal stays bounded. Unimplemented variants and malformed wrappers are rejected. A matching digest is not evidence of a dependency.
- Transfer supported visualization HTML as opaque bytes into the destination composer's agent-store `files/visualizations` directory. The transfer does not parse or execute the HTML. Identical bytes are reused; different bytes at the same path are not overwritten. Arbitrary text and paths do not imply ownership.
- Copy owned agent transcripts and explicitly referenced terminal snapshots. Transcript ownership follows the composer database and parent id. Terminal snapshots are stored outside Cursor's live `terminals` directory and do not restore a process or shell.
- Resolve a deletion family from composer records when the visible catalogue is stale. Name a blocked family and its owning workspace. An absent SQL NULL composer body does not block deletion of unrelated chats.
- Identify an installed file by its destination path, so chats can keep visualization or transcript files that share a display name.
- Validate supported native roots, manifest list ranges, and content hashes. A root that merely exists is not a complete snapshot. Unsupported structured closure is rejected instead of guessed.
- Record the native publication intent and the exact hashed recovery bytes before the renderer is published. An interrupted import checks the database and metadata hashes and does not replace an occupied or changed native destination. A header-only renderer catalogue entry still reserves its destination id.
- Decode canonical hex renderer state as well as `~`-prefixed base64. Protobuf identity remapping stays limited to evidenced subagent map-key fields. A UUID-shaped value or an unrelated 32-byte value is not an identity or a blob dependency just because a matching record exists.
- Leave unknown native stores, the profile-global agent-host database, and remote-session state in place when deleting a renderer chat. Contradictory workspace ownership stops that deletion. Read-only profile inspection and disposable-profile acceptance are documented separately.

## 1.1.0

### Added

- Write archive format 5. A hashed `index.sqlite` is the inventory and catalog, payloads are stored by SHA-256, and the required capabilities are `sqlite-index-v1` and `content-addressed-blobs-v1`. Format 4 remains readable. Older monolithic JSON exports are rejected.
- When Cursor has committed a supported per-session agent-host store, export a WAL-aware snapshot of that session's `session.sqlite` and `meta.json`. Import restores it only under the original free session ID, after schema, manifest, root, and identity checks, and only when the matching renderer ID is also free. A collision or unsupported layout becomes a remapped renderer-owned copy. Private protobuf and content-addressed state is not synthesized or merged. The profile-global agent-host database is not copied.
- Copy portable renderer records that belong to one chat, including drafts, conversation state, checkpoints, code-block diffs, and recognized artifact keys.
- Materialize an external header log into the exported conversation when Cursor stores the ordered headers in chunks.
- Choose workspace order in **Manage chats** from **Sort workspaces**. The active order, name or recent activity, is checked.
- Import a ZIP directly into a chosen **Manage chats** workspace row. Export checked chats or whole workspace rows from several same-profile workspaces into one streaming format-5 ZIP, then import that archive into one destination workspace.
- Record a non-destructive real-Cursor checklist with `scripts/acceptance-cursor.sh`. It stores the executable hash, version output, extension commit, and platform. It does not export, import, or send a message.

### Changed

- Bundle better-sqlite3 13.0.3 and SQLite 3.53.4 for offline access on x64 and arm64 Windows, macOS, and Linux (glibc and musl). Remove the system SQLite dependency and the `sqlitePath` setting.
- Enforce native SQL deadlines outside the busy worker, with parent-loss protection. Use typed Buffer and 64-bit integer IPC. Set FULL durability on the main database and on attached databases.
- Read selected resources in byte-bounded native batches. Reuse warm standalone workers that do not keep database handles. Insert prepared message and resource rows.
- Identify chat snapshots with `cct-snapshot-v2`. Record import side effects in the private journal (schema 2) and keep interrupted-import recovery.
- Treat a complete local transfer as preserved bytes, not as proof that Cursor can continue the Agent.
- Require a desktop host with VS Code API 1.128 or later.

### Fixed

- Accept nested message rows and standalone Agent rows. Preserve opaque conversation state that this build does not decode. Remap known identities inside supported state, including family and canvas references, task-result agent IDs, and subagent task links.
- Stream large deletion metadata instead of holding an entire deletion plan in one value.
- Show Windows paths with literal backslashes in human logs. Escape quotes and control characters.
- Verify a batched deletion with one `UNION ALL` query and check the result count.

## 1.0.1

### Chat transfer

- Remap composer and message identifiers inside Cursor's current `conversationState` format, including nested stream and tool rows, and keep parent and subagent ids aligned in that state.
- Treat a previous import as a new copy when its stored conversation state still contains the source chat id, so those older copies can be remapped correctly.
- Replace an archived model that is unavailable on the destination with the destination's current selection. Keep an available archived model, including unknown fields.
- On a repeated import of the same snapshot, repair the existing copy's unavailable model without creating another chat. Leave a model the user selected after import unchanged.
- Reconcile an interrupted model repair from the import journal, and ask to quit and reopen Cursor after a repair-only import.

### Workspace and chat selection

- Count user messages from stored top-level bubbles when Cursor's compatibility index is empty.
- Treat current-format chats that keep their history in conversation state as ready when the stored root user messages and state ids match.
- Mark current-format chats incomplete when nested stream or tool rows have no stored root, conversation state still names the source chat, or family metadata points at a missing composer.

## 1.0.0

Initial release of Cursor Chat Transit.

### Chat transfer

- Export selected conversations or a workspace's chat history to a ZIP archive and import it into another workspace or device.
- Include supported messages, local conversation state, images, plan files, and canvases.
- Transfer parent conversations together with their linked subagent chats, including nested subagents, and preserve their relationships on import.
- Process archives using bounded JSON records, streamed NDJSON parts, byte-bounded dependency reads, and separate binary resource files.
- Preserve existing conversations, recognize repeated imports, and create separate copies of changed snapshots. Re-import previously deleted chats as new copies when their recorded state can be verified.
- Preserve surviving text from incomplete conversations through the default-on **Export: Recover Text** setting, with clearly labelled preview fragments and gaps.
- Review available and missing history before importing an incomplete archive, with explicit confirmation for that import.
- Validate archive paths, records, checksums, and supported resource dependencies before publishing imported chats.
- Read exports without copying the full database. Stage imports outside Cursor's databases, write bounded batches, and verify the result with support for interrupted-import reconciliation.

### Workspace and chat selection

- Browse local, SSH, WSL, and container projects recorded in the local Cursor profile.
- Identify the current window's storage and distinguish additional storage entries for the same project. Prioritize the storage expected to open with that project when it can be identified.
- Prepare workspace pickers with lightweight history checks and a reversible filter for empty entries, including empty import destinations.
- List titled chats by recent activity, followed by untitled chats. Select parent conversations for export with their subagents included automatically.
- Count titled and untitled chats per workspace on demand, and show user-message counts and detected legacy or Agent formats for individual chats.
- Select conversations with messages that pass source-data checks, while preserving manual selection changes made during analysis.
- Run statistics in a cancellable background process and keep workspace and chat pickers open when switching windows.

### Manage chats

- Browse workspaces, conversations, and nested subagent chats in a persistent native tree.
- Search workspace names, paths, and chat titles across visible workspaces, including collapsed rows, without reading message bodies.
- Sort workspace groups by name or recent database activity, with the expected storage first within each project.
- Show partial search results with explicit reasons for unavailable workspaces. Close and reopen search while shared catalogue reads continue.
- Use checkboxes to select chats or workspace data, select all visible entries, clear selection, and toggle empty or unavailable workspaces without repeating the scan.
- Select empty workspaces or chats with transfer issues for review. Check a parent conversation together with its confirmed descendants.
- Delete selected chats or an inactive workspace's local Cursor data after reviewing the scope and confirming the operation. Project files remain untouched.
- Apply the same checked selection to row and toolbar deletion actions. Keep the current workspace selectable while protecting its storage directory from deletion.
- Recheck ownership and source state before deletion, retain shared or unsupported data, and report partial or uncertain outcomes.

### Operations and diagnostics

- Show transfer stages, the current chat or file, elapsed time, and remaining-time estimates for stages with measurable progress.
- Retain a final operation duration synchronized with the log, with compact recent results and expandable per-chat details.
- Write timestamped logs with an explicit UTC offset, bracketed severity, operation IDs, concrete file paths, chat identifiers, byte counts, and durations with human-readable equivalents.
- Provide a copyable diagnostic report and a guarded action for clearing transfer locks whose owners are verified to have stopped.
- Offer Cursor's normal **Quit Cursor** action after imports that add chats and after modifying deletion operations.
- Release completed operations independently of notification dismissal.
- Configure the local Cursor profile, SQLite executable, plan directory, temporary-file location, SQLite operation deadlines, lock waits, JSON property limits, text recovery, and log verbosity.

### Development and distribution

- Provide Task and npm commands for setup, checks, packaging, and explicit local version and changelog preparation.
- Run automated tests, SQLite integration checks on Linux, Windows, and macOS, and extension-host smoke tests in CI.
- Publish version tags, VSIX packages, and SHA-256 checksums through GitHub Releases after validation, without extension registry publishing.
- Distribute under the MIT license with the original and subsequent copyright notices.
