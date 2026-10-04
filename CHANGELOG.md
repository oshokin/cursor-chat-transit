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
- Recover usable history from incomplete exports with an explicit per-import review.

### Workspace and chat selection

- Manage chats in a persistent native view with workspace and chat search, checkboxes with consistent deletion scope across row and toolbar actions, selection controls, data checks and bulk history deletion with explicit confirmation and a Quit Cursor action afterward.
- Search workspace names, paths, and chat titles across collapsed manager rows without reading message bodies.
- Use the same workspace and chat ordering in the manager and transfer pickers.
- Keep workspace and chat pickers open when switching windows; retain explicit cancellation.
- Index global chat headers once per scan, group selected checks by workspace, and batch deletion requests while retaining indexed record lookups.
- Toggle empty or unavailable workspace visibility without repeating the scan.
- Preserve available text in ZIP exports, with labelled preview fragments and gaps controlled by the default-on Export: Recover Text setting; review incomplete history before importing.

- Group workspaces by location, with the current workspace first, and distinguish local, SSH, WSL, and container projects.
- List titled chats by recent activity, followed by untitled chats.
- Count titled and untitled chats per workspace on demand, with explicit storage bindings taking priority over reused project paths.
- Show user-message counts and detected legacy or Agent formats for individual chats.
- Run statistics in a cancellable background process while keeping search, selection, and navigation available.

- Prepare the workspace list automatically using lightweight history checks and short read views; keep the current workspace visible and provide a one-click action to show empty destinations.
- Select nonempty chats that pass source-data checks for messages and supported resources; preserve manual selection changes during analysis.
- Present a transparent blue-to-teal extension mark and consistent monochrome command icons.

### Operations and diagnostics

- Show transfer stages, elapsed time, and remaining-time estimates for measurable work; retain a final total synchronized with the operation log.
- Keep recent results compact with expandable per-chat details.
- Write timestamped operation logs with concrete file paths, chat identity, byte counts, exact durations with human-readable equivalents, and error codes.
- Provide a copyable diagnostic report and a guarded action for clearing stale transfer locks.
- Offer Cursor's normal quit action after an import adds chats.
- Release completed operations independently of notification dismissal; retain explicit consent before recovery writes.
- Read exports without copying the full database; prepare imports outside Cursor's database and write bounded batches with journaled recovery and verification.
- Configure local storage paths, SQLite query deadlines, lock waits, and log verbosity.

### Development and distribution

- Provide Task and npm commands for setup, checks, packaging, and explicit local release preparation.
- Validate changes with automated tests, cross-platform SQLite checks, and extension-host smoke tests in CI.
- Publish verified VSIX packages and checksums as GitHub Release assets, with no registry publishing.
- Distribute under the MIT license with the required copyright notices.
