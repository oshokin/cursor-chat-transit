# Usage

Counts, filters, settings, and recovery. Install, export, and import steps are in the [README](../README.md).

## Find and inspect chats

Workspaces are grouped by location, with the current workspace first. Each row shows the project name, location, and path. Chats with titles appear first, ordered by recent activity; untitled chats follow in the same order. Missing titles or dates do not hide a chat. Technical IDs appear only when needed to distinguish otherwise identical rows.

### Workspace counts

In the workspace picker, use the chart button, **Count chats in each workspace**. Results appear under each workspace, for example:

> 12 titled · 3 untitled · /home/alex/project

“Titled” means the stored title contains non-whitespace text. “Untitled” means it does not; it does not mean the conversation is empty or disposable. Counts include the unique chats in the extension's resolved workspace list, including archived chats. They can differ from Cursor's filtered chat list.

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

The picker toolbar runs left to right: **Statistics**, then **Filter** (workspaces) or **Select checked chats** (chats). During a scan, **Stop analysis** replaces those actions.

In the workspace picker, **Check chats and hide workspaces without readable history** examines the listed chats and hides workspaces that have no chats, only confirmed empty chats, or only missing chat bodies with no remaining messages. This is a temporary view filter: it never deletes workspace folders, Cursor databases, or chat records. The same button becomes **Show all workspaces**. Reopening the picker restores the full list.

A missing project directory does not mean its stored chats are gone. Workspaces with incomplete data, unsupported formats, unknown state, or read errors remain visible. Legacy chats remain available when their history can be transferred.

In the chat picker, **Check all chats and select complete ones with messages** checks message references, stored message records, supported conversation dependencies, and referenced resources. After the scan, it replaces the selection with chats that passed those checks and contain indexed messages. It checks the entire list, including chats outside the current text filter. If you change checkboxes during the scan, your selection takes priority. Cancellation or a worker failure does not apply a partial selection.

These checks use the export reader without writing a ZIP. They read messages and resources one after another, so they take longer than metadata-only statistics. Source data can change after the check; export and import still validate on their own. A successful check does not mean Cursor will continue the chat. Complete legacy history can still be selected when Cursor shows **Chat Too Old**.

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

Incomplete exports are rejected by default. To recover readable history when a complete export is no longer available, enable `cursorChatTransit.import.allowPartial` in user settings. Recovery may import usable chats and skip unusable ones; it cannot reconstruct missing state or guarantee continuation. Unsafe paths, invalid JSON, and conflicting data remain errors. Review the result and turn recovery off when finished.

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

| Setting                                            | Default | Purpose                                                                       |
| -------------------------------------------------- | ------- | ----------------------------------------------------------------------------- |
| `cursorChatTransit.userDataDir`                    | Empty   | Use a specific local Cursor profile; empty means automatic discovery          |
| `cursorChatTransit.sqlitePath`                     | Empty   | Absolute path to SQLite when it is not on `PATH`                              |
| `cursorChatTransit.plansDirectory`                 | Empty   | Read and restore plans in a custom directory; empty uses `~/.cursor/plans`    |
| `cursorChatTransit.import.allowPartial`            | `false` | Attempt recovery from incomplete exports                                      |
| `cursorChatTransit.sqlite.operationTimeoutSeconds` | `600`   | Query/process or persistent-session request deadline, from 30 to 3600 seconds |
| `cursorChatTransit.sqlite.busyTimeoutSeconds`      | `5`     | SQLite busy-handler wait, from 0 to 30 seconds                                |
| `cursorChatTransit.logLevel`                       | `info`  | Minimum operation-log level: `info`, `warn`, or `error`                       |

Path and timeout settings are machine-scoped. Paths must be absolute; `~` and shell variables are not expanded. The plans setting does not change where Cursor saves new plans. Recovery and log level are application settings. Repository settings cannot redirect these paths or silently enable recovery.

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
