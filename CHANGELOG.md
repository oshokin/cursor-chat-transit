# Changelog

## [1.1.0] - 2026-10-31

### Added

- Bundle better-sqlite3 13.0.3 and SQLite 3.53.4 for offline native database access on x64/arm64 Windows, macOS and Linux.
- Enforce native SQL deadlines outside the busy worker, with parent-loss protection and rollback tests.
- Add typed Buffer/64-bit integer IPC and explicit FULL durability for main and attached databases.

### Changed

- Remove the system SQLite dependency and the obsolete sqlitePath setting.
- Use byte-bounded native resource reads, prepared message/resource inserts, and shared warm standalone workers without retained database handles.
- Keep archive version, journal state, supported schema checks and interrupted-import recovery compatible.

### Fixed

- Display Windows paths with literal backslashes in human logs while safely escaping quotes and controls.
- Verify batched deletions with one UNION ALL query and check the result count.

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
