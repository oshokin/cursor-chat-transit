# Usage

Counts, filters, settings, and recovery. Install, export, and import steps are in the [README](../README.md).

## Find and inspect chats

Workspaces are grouped by location, with the current workspace first. Each row shows the project name, location, and path. Chats with titles appear first, ordered by recent activity; untitled chats follow in the same order. Missing titles or dates do not hide a chat. Technical IDs appear only when needed to distinguish otherwise identical rows.

### Workspace counts

In the workspace picker, use the chart button, **Count chats in each workspace**. Results appear under each workspace, for example:

> 12 titled · 3 untitled · /home/alex/project

“Titled” means the stored title contains non-whitespace text. “Untitled” means it does not; it does not mean the conversation is empty or disposable. Counts include the unique chats in the extension's resolved workspace list, including archived chats. An explicit storage ID takes priority over a matching project path. Headers without an ID use URI matching, and workspace-local lists may still share chats; equal counts alone do not prove duplicate storage. They can differ from Cursor's filtered chat list.

### Chat statistics

In **Select chats…**, use the chart button, **Count user messages and identify chat formats**. Each row shows a result such as:

> 3 user messages · Legacy format — may not continue

| Label                            | Meaning                                                                                                                                         |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| User messages                    | Recognized user entries in the stored conversation index, or a supported inline conversation; assistant replies and tool responses are excluded |
| Legacy format — may not continue | The stored `isNAL` flag is explicitly `false`; Cursor may show **Chat Too Old**                                                                 |
| Agent format                     | The stored `isNAL` flag is explicitly `true`; this is not a continuation guarantee                                                              |
| Format unknown                   | The record does not identify a recognized format                                                                                                |
| Message count unavailable        | The stored conversation index is absent or cannot be counted reliably                                                                           |
| Statistics unavailable           | Metadata could not be read; check the operation log                                                                                             |

Analysis is optional and runs in a background process. You can keep typing, scrolling, selecting, or accepting while it runs. The title reports completed rows. The chart button becomes **Stop analysis**; closing or accepting the picker also cancels the scan. Completed results remain visible after stopping. Run analysis again to refresh them. Results last only while that picker is open and are not updated as Cursor writes new messages.

Analysis does not modify chats, convert formats, or read the entire conversation blob graph. Exporting a legacy conversation does not make Cursor continue it.

### Filter workspaces and select complete chats

The workspace picker prepares its filtered list automatically when opened. The title shows **Preparing workspace list…** with a native busy indicator; typing and cancellation remain available. The toolbar offers **Statistics** and a reversible **Show all workspaces** / **Hide empty workspaces** toggle whenever the scan finds empty entries. The chat picker offers **Statistics**, then **Select checked chats**. During a scan, **Stop analysis** replaces these actions.

Automatic workspace preparation hides entries that have no chats, only confirmed empty chats, or only missing chat bodies with no remaining messages. The current workspace stays visible, including when empty. This is a temporary view filter: it never deletes workspace folders, Cursor databases, or chat records. **Show all workspaces** restores hidden entries without another scan, including empty destinations for import. The toggle changes only the view and does not repeat the scan. Reopening the picker performs a fresh check. If preparation fails or is stopped, the full list remains available; partial filter results are not applied.

A missing project directory does not mean its stored chats are gone. Workspaces with incomplete data, unsupported formats, unknown state, or read errors remain visible. Legacy chats remain available when their history can be transferred.

In the chat picker, **Check all chats and select complete ones with messages** checks message references, stored message records, supported conversation dependencies, and referenced resources. After the scan, it replaces the selection with chats that passed those checks and contain indexed messages. It checks the entire list, including chats outside the current text filter. If you change checkboxes during the scan, your selection takes priority. Cancellation or a worker failure does not apply a partial selection.

Workspace filtering checks for stored history without reading message bodies or dependency blobs. Checked chat selection uses the export reader without writing a ZIP: it reads messages sequentially and dependencies in byte-bounded batches, so it still takes longer than metadata-only statistics. Source data can change after the check; export and import still validate on their own. A successful check does not mean Cursor will continue the chat. Complete legacy history can still be selected when Cursor shows **Chat Too Old**.

## Archive contents and limits

An archive contains a manifest, per-chat metadata, bounded NDJSON parts, and supported binary resources:

- Chat headers, conversation entries, and message records.
- Referenced local conversation blobs.
- Chat images, Cursor plan files, and canvases when available and supported.

This build writes archive format version 5 and reads versions 5 and 4. Version 5
uses a hashed SQLite inventory and content-addressed payloads; version 4 remains
readable through its bounded NDJSON inventory. Monolithic JSON files and other
archive versions are not accepted. The archive as a whole can exceed 1 GiB; an
individual JSON record or SQLite value is limited to 32 MiB. See the
[storage and archive contract](architecture.md) for details.

An export is a chat archive, not a complete Cursor profile or project backup. It does not copy your source tree or intentionally collect account credentials and extension settings. Messages and attachments may themselves contain sensitive information.

Assume the ZIP contains private data: prompts, replies, tool output, source
fragments, local and remote paths, images, plans, canvases, and any secrets pasted
into the chat. Store and transmit it like a credential-bearing backup. Do not post
an unredacted ZIP or `state.vscdb` publicly.

### Read result classes correctly

- **Complete** means all records and supported resources required by Transit's
  renderer-side contract were present and validated.
- **History-only** means readable text can be published, but missing or recovered
  data prevents a continuation claim.
- **Unavailable** means the supported reader cannot safely publish that chat.
- **Already imported** means the same semantic snapshot is recorded at this
  destination; it does not re-test rendering or continuation.

These classes do not inspect Cursor's server state. A supported committed
host-owned session is exported as a separately validated SQLite snapshot; it is
restored only when its original session ID is free. Unsupported layouts, collisions,
and renderer-only exports cannot prove that the renderer mirror contains every
host-authoritative write.

## Repeat imports and recovery

| Situation                                                  | Result                                                                       |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------- |
| The same snapshot was already imported into this workspace | Keep the existing copy                                                       |
| You deleted the imported chat in Cursor                    | Restore it as a new independent copy when the recorded state can be verified |
| The source chat changed                                    | Add a separate copy                                                          |
| You continued or renamed the imported chat                 | Keep your changes                                                            |
| Two chats have the same title                              | Treat them as separate conversations                                         |
| The destination workspace is different                     | Import independently into that workspace                                     |
| An earlier import stopped partway through                  | Check the recorded pending state before writing another copy                 |

Import receipts are stored in the extension's local storage. Clearing that storage removes the record used to recognize earlier imports. Resource conflicts remain errors: a plan with the same filename and different contents is not overwritten.

Incomplete archives are inspected before publication. If some chats are usable, review the numbers of complete, history-only, unavailable, and already imported chats, then choose **Import available history** or Cancel. Missing resources are counted by kind. Missing bodies are skipped unless the exporter supplied supported, explicitly labelled preview fragments or gaps. Original missing text is never invented. When no new usable chats remain, the extension explains the result instead of creating empty copies. A repeat import still recognizes existing copies.

**Export: Recover Text** controls salvage during export and defaults to enabled. It does not bypass import validation or approve an incomplete import for you. Unsafe archive paths, invalid records, checksums, unsupported state formats, and database errors are not bypassed by consent.

## Available history in ZIP exports

The existing ZIP exporter is the only export mechanism. `cursorChatTransit.export.recoverText` is an application setting read from your explicit User value. It defaults to `true`; a workspace cannot change it.

- Existing message bodies always win over previews and are preserved.
- A missing body with a known user or assistant role and an associated `grouping.textPreview` becomes a message labelled **Recovered from preview. Full message unavailable.** The fragment may be truncated.
- A missing body with a known role and no preview becomes a labelled gap only if some readable text or a usable preview survives in the chat.
- Missing composers, unknown roles, invalid records and unsupported formats are not repaired by guessing. An archive can still be incomplete or a chat unavailable for import.

The archive marks recovered text as incomplete history. Import shows that status and waits for approval. Turning the setting off still exports the original available records and header previews, but creates no replacement message records. Import rejects a chat whose required message records are absent; approving partial history does not bypass this check. Turning the setting off does not remove annotations from an already recovered copy. Source records stay unchanged in either mode.

| Source data                                                                   | Recover Text off                                    | Recover Text on                                 |
| ----------------------------------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------- |
| All message records exist                                                     | Original records                                    | Same records                                    |
| A record exists with empty text or tool data                                  | Original record                                     | Same record; previews do not replace it         |
| A message record is absent, with known author role and associated preview     | Header preview is preserved, but no body is created | A labelled preview message is added to the ZIP  |
| A message record is absent, without preview, but other readable text survives | Missing reference remains                           | A labelled gap is added for a known author role |
| Only agent resources are missing                                              | Export remains incomplete                           | Same; the setting cannot recreate resources     |
| Composer metadata is missing or the author role is unknown                    | No guessed replacement                              | Same                                            |

This is a salvage option for absent message records, not a repair switch for empty messages, older chat formats, broken UI rendering or Agent continuation. Keep it enabled to preserve available text in partial exports; disable it when the ZIP must contain only original records. Complete chats are unaffected. The option applies to the next export, not to existing archives or imports.

After import and restart, open the copied chat and use Cursor's **Export Transcript**. The goal is readable surviving history, not guaranteed Agent continuation. SQLite round-trip tests do not prove that a particular Cursor build will render a recovered chat or export its transcript. Missing text, tool results and server-side state cannot be recreated from a short preview. There is no Markdown exporter, separate recovery command, or automatic format migration.

## Manage chats

Choose **Manage chats** in the existing sidebar footer. The native tree supports search, checks and deletion of selected history. Export stays in the main transfer view. There is no manual per-workspace hiding preference.

The initial scan hides confirmed empty history and unavailable workspace reads. **Show all workspaces** reveals those rows; the same toolbar position then offers **Hide empty or unavailable workspaces**. These are reversible view filters, not proof that data is disposable. Unknown formats are retained when the scan cannot establish an empty or unavailable state.

Toolbar order follows the workflow: Search, Refresh, visibility, Select all visible or Clear selection, then Check selected and Delete selected when something is checked. Search finds names, paths and chat titles in the visible workspace set, including collapsed rows. It reveals a result in the tree; it does not create a separate bulk-selection filter. Message text is not indexed.

Use checkboxes for deletion selection. A workspace checkbox includes its chats. Unchecking a child leaves its siblings selected. Selection survives focus changes and visibility toggles. **Clear selection** also clears hidden selections; **Refresh** clears all selections and reloads metadata. **Select all visible** selects the current workspace rows, including their collapsed children. Review the confirmation because selected rows may subsequently have been hidden.

Each chat or workspace has inline **Check** and one trash action. Checking a workspace selects that workspace’s local Cursor data, not only its chats. To delete chats and keep the workspace, check the chats themselves. **Delete selected…** always acts on every checked row, whether invoked from the toolbar or a row. Clicking or right-clicking a row only changes native focus; it never clears checkboxes or adds that row. With no checked items, a workspace row offers **Delete workspace data…** and a chat row offers **Delete chat…**. The workspace open in the current window cannot have its data deleted from that window. The confirmation lists the exact scope, including checked items hidden by a filter. Checks run without writing Cursor data. A check is not a guarantee that Cursor can continue a conversation, or authorization to delete it.

### Delete selected history

Close all other Cursor windows and stop running Agent tasks before starting. Select chats or workspaces, choose **Delete history**, review the counts and confirm **Delete chats**. Do not use chats while deletion is running. There is no automatic undo or backup: make your own backup beforehand if you need to keep this history. Cancelling the confirmation performs no deletion and does not quit Cursor.

Deletion runs through the existing cancellable transfer worker, with progress and details in Operations. It does not wait for shutdown, inspect OS processes, or run as a detached task. No Linux-only check is applied. The existing SQLite operation deadline and busy timeout apply. A busy database is an error after that bounded wait; the extension never force-unlocks it.

After a modifying operation, use **Quit Cursor** in the existing sidebar and reopen the IDE. The extension never quits automatically. If the host cannot expose that native action, quit through the application menu. Completion notifications do not retain the operation lock.

Chat-only deletion removes supported, exclusively owned composer and message records. Shared chats, unresolved ownership, unreadable metadata, changed index rows, relevant triggers and foreign-key dependencies are retained or stop that chat. The workspace directory stays.

**Delete workspace data** removes one inactive `User/workspaceStorage/<storageId>` directory and the supported history that belongs only to it. That includes saved editor state, local resources and other extensions’ data stored in that directory. It does not delete the project, a `.code-workspace` file, Git data, SSH files, global settings, shared agent blobs or the global plans folder. An empty supported workspace can be deleted. Shared or unreadable history blocks deletion of that workspace directory; nothing in that workspace-data plan is deleted. Deleting selected chats still removes chats that belong only to the workspace and reports shared chats as skipped. SQLite commits and directory removal are not one transaction: a later filesystem error is reported as partial and is not rolled back. Opening the project again can create a new empty local storage directory. Deleting chats does not immediately shrink `state.vscdb`: SQLite keeps freed pages for reuse inside the file. No VACUUM runs. There is no undo.

Checking a conversation also checks its confirmed subagents. The inline check uses the checkbox selection when any row is checked. **Select chats with transfer issues** checks every chat in the current profile, including the current window and hidden rows, and replaces the checked set with chats that are incomplete, have no stored data, or have no messages. A parent with a transfer issue also selects its confirmed subagents, including a subagent whose own check passed. A healthy parent is not selected because a subagent failed. Rows that could not be checked stay unchecked. **Select empty workspaces** checks the full inventory, including rows hidden by the eye toggle, and replaces the checked set with workspaces that have no chat history in the supported indexes. Empty here means no messages, previews, or known resource history. It does not mean the directory has no files. The command does not delete anything. The existing trash action still asks once, then deletes workspace-local Cursor state and keeps project files. A workspace that gains a chat after it was selected is refused before the first write. The current window, shared history, unread databases, and unsupported records are not selected. An unrecognized composer shape, a failed read, or a JSON limit is not treated as empty. File size and time are not proof against a Cursor window that is still writing; close other windows and stop Agent tasks first. Refresh stays in the view overflow menu.

Cancellation rolls back the active workspace transaction; earlier workspace commits remain deleted and are reported. A failure stops subsequent workspaces. A lost worker result or lost COMMIT acknowledgement is reported as uncertain, not as a successful rollback; quit and reopen Cursor before checking the result and retrying. Multiple attached WAL databases do not form a crash-atomic group. There is no automatic retry.

Stopping tasks and closing other windows is a user precondition, not something the extension verifies. SQLite transaction checks cannot prevent Cursor from later writing its cached state back. Test deletion and the full quit/reopen cycle on a disposable profile for your Cursor build before relying on it for valuable history.

Workspace and chat Quick Picks stay open across focus changes. Escape, accepting a selection, and the explicit Stop action retain their normal meanings. Native file dialogs are controlled by the operating system.

## Local storage and remote projects

The selected workspace identifies which chats to transfer, not where the ZIP file must live. Cursor Chat Transit uses the local Cursor profile's global and workspace databases, including entries for remote projects. Different SSH authorities remain distinct even when project paths match.

File dialogs start locally. A remote ZIP selected for import is read through the editor's file provider. Export destinations must be local; copy the archive elsewhere using your usual tools.

The extension runs on the local UI side. It transfers local profile records that
refer to SSH, WSL, or container workspaces; it does not log into the remote host,
copy its project tree, recreate a container, restore remote files, or recreate
account/backend state. A successful remote-workspace import therefore proves only
that the local catalogue copy was installed. Verify the remote authority is
reachable and open the imported chat there before making any continuation claim.

## Real-Cursor acceptance

Synthetic and SQLite tests cannot certify Cursor's private renderer or Agent
runtime. For each release candidate and supported Cursor build:

1. Run `scripts/acceptance-cursor.sh --output <directory>`. It records the Cursor
   executable SHA-256, version output, extension commit, platform, and a checklist.
   It does not open databases, export chats, import chats, or send messages.
2. Use a disposable local profile and non-sensitive fixture chat. Export it, import
   it under a fresh workspace, quit and reopen Cursor, and record whether text,
   images, plans, canvases, and subagents that are present in the fixture render.
3. Record the result class shown by Transit. Do not convert a history-only or
   unavailable result into “complete” in the acceptance notes.
4. To test continuation, explicitly opt in to a mutation and send one disposable
   message in the imported copy. Record the exact Cursor build hash, account,
   workspace kind, time, and whether a response completed.
5. Repeat in an actual SSH/WSL/container workspace only when that environment is
   available. Record “not tested”; never infer remote recreation from a local pass.
6. Keep the generated report private if paths, usernames, authorities, or fixture
   details are sensitive.

The only defensible guarantee is evidence about that exact run: “this imported copy
accepted a new message in build `<hash>` under the recorded environment.” It is not
a guarantee for another chat, future Cursor build, account, machine, or remote
backend. The script's `--allow-mutation` flag only records consent in the checklist;
it does not automate Cursor or send a message.

Typical Cursor user-data directories:

| Platform | Directory                                        |
| -------- | ------------------------------------------------ |
| Linux    | `$XDG_CONFIG_HOME/Cursor`, or `~/.config/Cursor` |
| macOS    | `~/Library/Application Support/Cursor`           |
| Windows  | `%APPDATA%\Cursor`                               |

For an explicit profile, select the directory containing `User`, not a project directory or an individual database. The extension does not silently substitute another profile when that directory is unavailable.

## Settings

Open User Settings and search `@ext:oshokin.cursor-chat-transit`.

| Setting                                            | Default   | Purpose                                                                                                                         |
| -------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `cursorChatTransit.userDataDir`                    | Empty     | Use a specific local Cursor profile; empty means automatic discovery                                                            |
| `cursorChatTransit.plansDirectory`                 | Empty     | Read and restore plans in a custom directory; empty uses `~/.cursor/plans`                                                      |
| `cursorChatTransit.sqlite.operationTimeoutSeconds` | `600`     | Query/process or persistent-session request deadline, from 30 to 3600 seconds                                                   |
| `cursorChatTransit.sqlite.busyTimeoutSeconds`      | `5`       | SQLite busy-handler wait, from 0 to 30 seconds                                                                                  |
| `cursorChatTransit.export.recoverText`             | `true`    | Preserve labelled preview fragments and gaps when full message bodies are unavailable                                           |
| `cursorChatTransit.limits.maxJsonProperties`       | `1000000` | Maximum object properties in one JSON payload, from 100000 to 5000000. This is not a limit on lines, messages, or archive size. |
| `cursorChatTransit.temporaryDirectory`             | Empty     | Directory for temporary archive files. Empty uses the system temporary directory.                                               |
| `cursorChatTransit.logLevel`                       | `info`    | Minimum operation-log level: `info`, `warn`, or `error`                                                                         |

Path and timeout settings are machine-scoped. Paths must be absolute; `~` and shell variables are not expanded. The plans setting does not change where Cursor saves new plans. Log level is an application setting. Repository settings cannot redirect these paths. Recovery consent applies only to the current import.

Changing the profile clears the selected workspace. Changing storage paths or SQLite settings also invalidates the manager's cached metadata. Running worker jobs retain the settings captured for that job; new jobs use the new values. Log verbosity follows the current application setting.

`limits.maxJsonProperties` applies to the next operation, including statistics, export, import, and empty-workspace checks. The export and import worker uses that budget for chat headers, composer records, and message lines. A property-limit error is not a reason to raise the byte or nesting limits. `temporaryDirectory` must be an existing absolute directory on this computer. The extension creates and deletes only a private child of that directory. It does not move Cursor databases, operation journals, or the finished archive onto that disk.

Subagent chats stay under the chat that spawned them. Exporting that parent includes the linked subagents. The current window can be checked and its chats can be deleted; its workspace storage directory stays while that window is open. Manage chats orders workspace groups by name or by database activity. **Sort workspaces…** in the view menu chooses the mode. Recently active follows database and WAL writes, not the last time a project was opened. Inside one project, the storage Cursor opens is listed first. A project with only one storage has no extra storage label; the full path stays in the tooltip. The same folder name on a different path is a different project. **Current window** is the database this window has open. Choosing that database again keeps the label. **Opens with this folder** or **Opens with this workspace** appears only when several storages share one project. **Other storage** is a separate history for that same project and can still be exported. **Storage not verified** appears only for those extra storages when the opening id cannot be computed. **Sort workspaces…** offers Name (A–Z) and Recent activity. Escape leaves the mode and the checkboxes unchanged. The native tree has no stable way to keep that title bold.

Timeouts apply to the next transfer or analysis. A query deadline is not a deadline for the whole operation; a busy-handler wait does not cover every kind of SQLite lock.

## Database access

SQLite is bundled through better-sqlite3 13.0.3 (SQLite 3.53.4). Queries run outside the extension host. Native SQL has an independent parent watchdog; cancellation and lost supervision release the worker and its writers. Windows log paths preserve normal single backslash separators, including UNC and extended-length paths.

Exports read selected records through a read-only transaction and release it before archive hashing and compression. Imports prepare rows outside Cursor's database, write bounded batches, publish chat headers, and verify the result. Neither operation creates a full database backup. The extension has no full-profile restore command; its journal supports interrupted-import reconciliation, not arbitrary rollback.

In WAL mode, reads allow concurrent writes but can delay checkpointing while a transaction is open. Other journal modes follow SQLite's normal reader/writer locking rules. The extension does not change journal mode or force checkpoints. Statistics use short read transactions and release them between rows.

## Progress and troubleshooting

The sidebar shows the current transfer stage, chat or file, and elapsed time. Remaining time appears only when the current stage has measurable progress. Estimates apply to that stage, not the entire transfer.

**Open operation log** opens **Cursor Chat Transit — Operations**. Lines use local time with an explicit UTC offset, bracketed severity, and an operation ID:

```text
[2026-10-02 09:30:12.345+03:00] [INFO] Workspace statistics started operation=12ab34cd
```

File actions include concrete paths, chat identity when available, byte counts with readable units, durations, and failure codes. Message bodies and SQL are not logged. **Diagnostics** opens a separate dialog with **Copy report** and **Close**.

| Problem                               | Action                                                                                    |
| ------------------------------------- | ----------------------------------------------------------------------------------------- |
| SQLite is unavailable                 | Reinstall the full VSIX and use a supported Cursor runtime with Node-API 10               |
| A workspace is missing                | Open it in Cursor and check the selected local profile                                    |
| An imported chat is missing           | Quit and reopen Cursor, then check the destination workspace                              |
| Cursor shows **Chat Too Old**         | Preserve or export the history and start a new chat; format analysis does not migrate it  |
| Statistics are unavailable            | Check the operation log; a failed read is not a zero count                                |
| Data is incomplete or conflicts       | Inspect the result and re-export from the source when possible                            |
| A transfer lock remains after a crash | Use **Clear stale lock** when offered; only a verified dead owner's lock can be removed   |
| SQLite reports a lock                 | Stop the operation and inspect the log; clearing an extension lock does not unlock SQLite |

Do not delete Cursor's `state.vscdb`, `-wal`, or `-shm` files to clear an extension lock. When [reporting a problem](https://github.com/oshokin/cursor-chat-transit/issues), include the extension version, Cursor version, operating system, and a redacted diagnostic report. Do not attach private chat databases or exports to a public issue.

## Activity and duration

Recent activity keeps the result, total duration, and available actions visible. **Chat details (N)** expands the per-chat results; it starts collapsed for each new result. Opening the details does not hide the result or the operation-log action.

Elapsed time and the final **Total** use the same monotonic clock as the operation log, from the start of the command through its terminal result. This includes time spent choosing files and chats. The final value is frozen for successful, unchanged, incomplete, cancelled, and failed operations. Stage labels, the current item, and stage estimates are removed at completion.

Duration fields retain exact milliseconds and add a compact human-readable value, for example `elapsedMs=87682 (1m 27s)` or `timeoutMs=600000 (10m 0s)`. Subsecond durations use milliseconds. Timestamps retain their existing local-time format and explicit UTC offset.
