# Changelog

## 1.0.0

Initial release of Cursor Chat Transit.

### Chat transfer

- Export selected chats or a workspace's chat history to a ZIP archive and import it into another workspace or device.
- Include supported messages, conversation state, images, plan files, and canvases.
- Process large archives with bounded JSON records, streamed NDJSON parts, byte-bounded dependency reads, and binary resource files.
- Read independent archive metadata and checksums with bounded concurrency while preserving deterministic inventory order.
- Preserve existing conversations, recognize repeated imports, and create separate copies of changed snapshots.
- Restore deleted imported chats as independent copies when their recorded state can be verified.
- Recover usable history from incomplete exports with optional recovery mode.

### Workspace and chat selection

- Group workspaces by location, with the current workspace first, and distinguish local, SSH, WSL, and container projects.
- List titled chats by recent activity, followed by untitled chats.
- Count titled and untitled chats per workspace on demand, with explicit storage bindings taking priority over reused project paths.
- Show user-message counts and detected legacy or Agent formats for individual chats.
- Run statistics in a cancellable background process while keeping search, selection, and navigation available.

- Filter workspaces without readable chat history using lightweight presence checks and short read views, with a one-click action to show every workspace again.
- Select nonempty chats that pass source-data checks for messages and supported resources; preserve manual selection changes during analysis.
- Present a transparent blue-to-teal extension mark and consistent monochrome command icons.

### Operations and diagnostics

- Show transfer stages, elapsed time, and remaining-time estimates for measurable work.
- Write timestamped operation logs with concrete file paths, chat identity, byte counts, durations, and error codes.
- Provide a copyable diagnostic report and a guarded action for clearing stale transfer locks.
- Offer Cursor's normal quit action after an import adds chats.
- Read exports without copying the full database; prepare imports outside Cursor's database and write bounded batches with journaled recovery and verification.
- Configure local storage paths, SQLite query deadlines, lock waits, recovery mode, and log verbosity.

### Development and distribution

- Provide Task and npm commands for setup, checks, packaging, and explicit local release preparation.
- Validate changes with automated tests, cross-platform SQLite checks, and extension-host smoke tests in CI.
- Publish verified VSIX packages and checksums as GitHub Release assets, with no registry publishing.
- Distribute under the MIT license with the required copyright notices.
