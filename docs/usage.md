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

The supported archive format is version 4. Monolithic JSON files and other archive versions are not accepted. The archive as a whole can exceed 1 GiB; an individual JSON record or SQLite value is limited to 32 MiB. See the [storage and archive contract](architecture.md) for details.

An export is a chat archive, not a complete Cursor profile or project backup. It does not copy your source tree or intentionally collect account credentials and extension settings. Messages and attachments may themselves contain sensitive information.

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

Toolbar order follows the workflow: Search, Refresh, visibility, Select all visible, Clear selection, Check selected, Delete checked history. Search finds names, paths and chat titles in the visible workspace set, including collapsed rows. It reveals a result in the tree; it does not create a separate bulk-selection filter. Message text is not indexed.

Use checkboxes for deletion selection. A workspace checkbox includes its chats. Unchecking a child leaves its siblings selected. Selection survives focus changes and visibility toggles. **Clear selection** also clears hidden selections; **Refresh** clears all selections and reloads metadata. **Select all visible** selects the current workspace rows, including their collapsed children. Review the confirmation because selected rows may subsequently have been hidden.

Each chat or workspace has inline **Check** and **Delete history** actions. **Delete checked history** always acts on every checked chat or workspace, whether invoked from the toolbar or a row. Clicking or right-clicking a row only changes native focus/selection; it never clears checkboxes or adds that row to the deletion. With no checked items, the row action becomes **Delete this history** and acts only on that row; the toolbar asks you to check items first. The confirmation lists the exact resolved chat count and workspace scopes, including checked items hidden by a filter. Checks run without writing Cursor data. A check is not a guarantee that Cursor can continue a conversation, or authorization to delete it.

### Delete selected history

Close all other Cursor windows and stop running Agent tasks before starting. Select chats or workspaces, choose **Delete history**, review the counts and confirm **Delete chats**. Do not use chats while deletion is running. There is no automatic undo or backup: make your own backup beforehand if you need to keep this history. Cancelling the confirmation performs no deletion and does not quit Cursor.

Deletion runs through the existing cancellable transfer worker, with progress and details in Operations. It does not wait for shutdown, inspect OS processes, or run as a detached task. No Linux-only check is applied. The existing SQLite operation deadline and busy timeout apply. A busy database is an error after that bounded wait; the extension never force-unlocks it.

After a modifying operation, use **Quit Cursor** in the existing sidebar and reopen the IDE. The extension never quits automatically. If the host cannot expose that native action, quit through the application menu. Completion notifications do not retain the operation lock.

Only supported, exclusively owned composer/message records and known index entries are deleted. Shared chats, unresolved ownership, unreadable metadata, changed selected index rows, relevant triggers and foreign-key dependencies are retained or stop the operation. Project files, workspace storage folders, shared agent blobs, images, plans and canvases remain. Selecting an empty workspace has no effect. No VACUUM runs.

Cancellation rolls back the active workspace transaction; earlier workspace commits remain deleted and are reported. A failure stops subsequent workspaces. A lost worker result or lost COMMIT acknowledgement is reported as uncertain, not as a successful rollback; quit and reopen Cursor before checking the result and retrying. Multiple attached WAL databases do not form a crash-atomic group. There is no automatic retry.

Stopping tasks and closing other windows is a user precondition, not something the extension verifies. SQLite transaction checks cannot prevent Cursor from later writing its cached state back. Test deletion and the full quit/reopen cycle on a disposable profile for your Cursor build before relying on it for valuable history.

Workspace and chat Quick Picks stay open across focus changes. Escape, accepting a selection, and the explicit Stop action retain their normal meanings. Native file dialogs are controlled by the operating system.

## Local storage and remote projects

The selected workspace identifies which chats to transfer, not where the ZIP file must live. Cursor Chat Transit uses the local Cursor profile's global and workspace databases, including entries for remote projects. Different SSH authorities remain distinct even when project paths match.

File dialogs start locally. A remote ZIP selected for import is read through the editor's file provider. Export destinations must be local; copy the archive elsewhere using your usual tools.

Typical Cursor user-data directories:

| Platform | Directory                                        |
| -------- | ------------------------------------------------ |
| Linux    | `$XDG_CONFIG_HOME/Cursor`, or `~/.config/Cursor` |
| macOS    | `~/Library/Application Support/Cursor`           |
| Windows  | `%APPDATA%\Cursor`                               |

For an explicit profile, select the directory containing `User`, not a project directory or an individual database. The extension does not silently substitute another profile when that directory is unavailable.

## Settings

Open User Settings and search `@ext:oshokin.cursor-chat-transit`.

| Setting                                            | Default | Purpose                                                                               |
| -------------------------------------------------- | ------- | ------------------------------------------------------------------------------------- |
| `cursorChatTransit.userDataDir`                    | Empty   | Use a specific local Cursor profile; empty means automatic discovery                  |
| `cursorChatTransit.sqlitePath`                     | Empty   | Absolute path to SQLite when it is not on `PATH`                                      |
| `cursorChatTransit.plansDirectory`                 | Empty   | Read and restore plans in a custom directory; empty uses `~/.cursor/plans`            |
| `cursorChatTransit.sqlite.operationTimeoutSeconds` | `600`   | Query/process or persistent-session request deadline, from 30 to 3600 seconds         |
| `cursorChatTransit.sqlite.busyTimeoutSeconds`      | `5`     | SQLite busy-handler wait, from 0 to 30 seconds                                        |
| `cursorChatTransit.export.recoverText`             | `true`  | Preserve labelled preview fragments and gaps when full message bodies are unavailable |
| `cursorChatTransit.logLevel`                       | `info`  | Minimum operation-log level: `info`, `warn`, or `error`                               |

Path and timeout settings are machine-scoped. Paths must be absolute; `~` and shell variables are not expanded. The plans setting does not change where Cursor saves new plans. Log level is an application setting. Repository settings cannot redirect these paths. Recovery consent applies only to the current import.

Changing the profile clears the selected workspace. Changing storage paths or SQLite settings also invalidates the manager's cached metadata. Running worker jobs retain the settings captured for that job; new jobs use the new values. Log verbosity follows the current application setting.

Timeouts apply to the next transfer or analysis. A query deadline is not a deadline for the whole operation; a busy-handler wait does not cover every kind of SQLite lock.

## Database access

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
| SQLite is unavailable                 | Check `sqlite3 --version` and configure its executable path                               |
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
