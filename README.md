# Cursor Chat Transit

Move your Cursor chats between workspaces and devices.

Export selected conversations or a workspace's chat history to a JSON file, then import it into another Cursor workspace. Supported exports include chat titles, messages, images, plan files, and the local data needed to continue compatible conversations.

Choose a workspace once, then select **Export** or **Import**. Importing the same snapshot again does not create another copy; changed snapshots are added as separate conversations, preserving your existing chats.

## What you can do

- **Move selected chats or an entire workspace's chat history.** Keep conversation titles and messages together.
- **Work with local and Remote SSH projects.** Choose the project in the sidebar; JSON file dialogs start on your local computer.
- **Carry supported chat resources with you.** Exports include reachable local conversation blobs, chat images, and Cursor plan files when available.
- **Import the same snapshot again without creating another copy.** Changed snapshots become separate copies, preserving chats you have already continued.
- **See what happened.** Follow progress in the sidebar, open the operation log, or run Diagnostics for a separate status report.
- **Recover usable history from incomplete exports.** Optional recovery mode is off by default and clearly reports missing data.

## Requirements

- Cursor desktop, or a VS Code-compatible desktop host supporting API version 1.85 or later.
- Access to the local Cursor profile that contains the chats.
- A local `sqlite3` command-line executable, available on `PATH` or configured in the extension settings.

VS Code can host the extension to access Cursor storage; it does not provide Cursor's native chat interface. Browser-only editors are not supported.

To check SQLite availability:

```bash
sqlite3 --version
```

On Windows, macOS, or Linux, install SQLite using your preferred package manager or the [official SQLite tools](https://www.sqlite.org/download.html). If it is not on `PATH`, set `cursorChatTransit.sqlitePath` to the executable's absolute path.

## Install

Install a built `.vsix` package in Cursor:

1. Open **Extensions**.
2. Open the **…** menu and choose **Install from VSIX…**.
3. Select the package, then reload the editor if prompted.
4. Open **Cursor Chat Transit** in the Activity Bar.

To build a package yourself, see [Development](#development). A published Marketplace listing is not required to install a VSIX.

## Quick start

### Export chats

1. In the sidebar, use **Change…** to choose the workspace whose chats you want to export.
2. Select **Export chats**.
3. Choose all chats or select individual conversations.
4. Save the suggested `*.cursor-chat.json` file. You can edit its name before saving.

The suggested filename uses the workspace or selected chat name, cleans characters that are unsafe in filenames, and includes an export timestamp. The file remains ordinary JSON with a `.json` extension.

If an export is incomplete, the result identifies affected chats. Open the operation log for details before treating that file as a complete backup.

### Import chats

1. Choose the destination workspace in the sidebar.
2. Select **Import chats** and choose an export file.
3. Check the selected destination in the sidebar and wait for the import result.
4. After an import adds chats, choose **Quit Cursor** in the operation panel, then reopen Cursor to load them. The button uses Cursor's normal quit action and closes all windows in the current application instance. It does not reopen Cursor automatically.

Cursor controls any quit confirmation and unsaved-work prompts. The extension does not add a second confirmation or change Cursor's settings. If you have disabled quit confirmation in Cursor, the button may close the application immediately.

If the quit action is unavailable, quit Cursor from its application menu. The button appears only after an import adds chats. Exports, cancelled or failed imports, and imports that make no changes do not show it.

Imports create copies with new local chat and message IDs. Existing conversations are preserved. If every selected snapshot has already been imported, the operation makes no chat changes and does not require a restart.

## Local projects and Remote SSH

The selected workspace identifies **which project's chats** to read or write. It does not determine where the export file must live.

Cursor Chat Transit runs on the local side of the editor and uses the local Cursor profile's global and workspace databases, including entries associated with Remote SSH projects. A remote project URI is kept distinct from a local path, so projects on different SSH hosts are not grouped merely because their directory names match.

Import and export dialogs start in a local directory. If you explicitly choose a remote JSON file for import, the extension reads it through the editor's remote file provider. Export destinations must be local files; copy the resulting JSON elsewhere using your usual tools.

This extension does not transfer the project's source files. References to files that only exist on the original machine may still need the project to be checked out or opened at the destination.

## Finding a workspace or chat

The workspace picker shows the current workspace first, followed by **This computer**, **SSH**, **Containers**, **WSL**, other remote workspaces, and unidentified entries. Empty groups are omitted. Within each group, recently changed workspace storage comes first. This uses database and WAL modification times as an activity hint, not an exact history of when you opened the project.

Chats are listed by their last update, newest first, with creation time used when an update time is unavailable. Undated chats remain selectable at the bottom. Type to filter by title or the brief chat description. The list stays stable while it is open. Technical IDs are shown only when otherwise identical rows need disambiguation.

## What an export contains

| Included when available and supported | Purpose                                                          |
| ------------------------------------- | ---------------------------------------------------------------- |
| Chat titles and metadata              | Identify the conversations you selected                          |
| Conversation and message records      | Preserve the stored chat history                                 |
| Referenced local conversation blobs   | Carry supported state used by Cursor conversations               |
| Chat image attachments                | Keep supported attached images with the conversation             |
| Cursor plan files                     | Carry referenced `.plan.md` files from the local plans directory |

Exports use the extension's versioned JSON format. The current writer produces format 3; the reader also accepts format 2. Older files may lack resources needed to continue a conversation.

This is a chat export, not a complete Cursor profile or project backup. It does not intentionally collect account credentials, extension settings, or arbitrary project files. Chat content and attachments can themselves contain sensitive information, so review an export before sharing it.

## Importing the same file again

There is no overwrite-or-merge decision to make for every chat:

| Situation                                                         | Result                                                   |
| ----------------------------------------------------------------- | -------------------------------------------------------- |
| The same chat snapshot was already imported into this destination | Skip it; keep the existing copy                          |
| You deleted that imported chat in Cursor                          | Import again to create a new independent copy            |
| The source chat has changed since the earlier export              | Add a separate copy; keep the previous version           |
| You continued or renamed the imported chat                        | Importing the old snapshot does not replace your changes |
| Two different chats have the same title                           | Treat them as different conversations                    |
| The destination is a different workspace                          | Import independently into that workspace                 |
| An earlier import stopped partway through                         | Check the recorded state before creating any new copies  |

Leftover SQLite rows from a deleted chat are kept. The next import of the same snapshot writes a new independent copy and does not reuse those rows. An import that stopped partway through is still checked before any new copy is written.

The extension records import receipts in its own local storage. Clearing that storage removes its record of earlier imports. Chats imported before receipts were introduced may not be recognized as previous imports.

Separate chat copies do not override resource conflicts: a plan file with the same filename but different contents is still a conflict. The existing file is preserved.

## Recovering an incomplete export

By default, an export with missing required data is rejected before new chat data is written. The preferred fix is to export again from the original Cursor profile while the missing data is still available.

If that is no longer possible, enable recovery in your **user settings**:

```json
{
  "cursorChatTransit.import.allowPartial": true
}
```

Recovery can import complete chats, preserve readable history from incomplete chats, and skip unusable conversations. It does not reconstruct missing blobs or guarantee that a recovered chat can continue. Invalid JSON, unsafe resource paths, unsupported formats, and conflicting data remain errors.

Review the operation result and log. Turn recovery off again when you no longer need it.

## Settings

| Setting                                            | Default | When to change it                                                                                                       |
| -------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------- |
| `cursorChatTransit.userDataDir`                    | Empty   | Point to a specific **local Cursor user-data directory** instead of automatic discovery                                 |
| `cursorChatTransit.sqlitePath`                     | Empty   | Use a local SQLite executable that is not on `PATH`                                                                     |
| `cursorChatTransit.import.allowPartial`            | `false` | Attempt to recover readable history from an incomplete export                                                           |
| `cursorChatTransit.plansDirectory`                 | Empty   | Read and restore local plan files in a non-default directory; empty uses `~/.cursor/plans`                              |
| `cursorChatTransit.sqlite.operationTimeoutSeconds` | `600`   | Increase the deadline for each SQLite process on unusually large databases or slow disks; allowed range 30–3600 seconds |
| `cursorChatTransit.sqlite.busyTimeoutSeconds`      | `5`     | Wait longer for brief database contention; allowed range 0–30 seconds, with 0 meaning no wait                           |

Path and SQLite timeout settings are machine-scoped. Paths must be absolute; shell variables and `~` are not expanded. The plans setting changes where this extension looks, not where Cursor saves new plans. Recovery is a user/application setting. Workspace settings cannot silently enable recovery or redirect the extension to another profile.

For `userDataDir`, select the directory containing `User`, not the project directory or an individual `state.vscdb` file. Typical locations are:

| Platform | Cursor user-data directory                                                   |
| -------- | ---------------------------------------------------------------------------- |
| macOS    | `~/Library/Application Support/Cursor`                                       |
| Windows  | `%APPDATA%\Cursor`                                                           |
| Linux    | `$XDG_CONFIG_HOME/Cursor`, or `~/.config/Cursor` when that variable is unset |

An explicit directory is authoritative. If its expected databases are missing, the extension reports the problem instead of silently switching to a different profile.

## Commands

Open the Command Palette and search for **Cursor Chat Transit**:

| Command                  | Action                                         |
| ------------------------ | ---------------------------------------------- |
| Export Chats             | Export from the selected workspace             |
| Import Chats             | Import a JSON file into the selected workspace |
| Export Current Workspace | Prefer the workspace open in the editor        |
| Diagnostics              | Open a status report                           |
| Open Operation Log       | Show the import/export output channel          |
| Open Diagnostic Log      | Show the diagnostic output channel             |

## Diagnostics and troubleshooting

**Diagnostics** opens a status report. Detailed checks and operation logs use separate Output channels:

- **Cursor Chat Transit — Operations**
- **Cursor Chat Transit — Diagnostics**

| Problem                                      | What to do                                                                                      |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| SQLite cannot be found                       | Run `sqlite3 --version`, then set `cursorChatTransit.sqlitePath` if needed                      |
| The expected workspace is missing            | Open that project in Cursor and check that the correct local Cursor profile is selected         |
| Exported or imported chats appear incomplete | Read the operation log and re-export from the original profile with all required data available |
| Cursor cannot find an old project file       | Open or restore the project at the destination; chat export does not copy the project tree      |
| An imported chat does not appear             | Use **Quit Cursor** after a successful import, reopen Cursor, then check the selected workspace |
| Existing resource data differs               | Keep the existing file or data; inspect the conflict instead of overwriting it                  |
| The previous import needs checking           | Keep the export, log, and backups; do not delete the journal merely to bypass the check         |
| Another operation is running                 | Let it finish or cancel it before starting another import/export                                |
| A previous transfer needs attention          | Open the operation log; close Cursor; delete only the named leftover `.lock` file               |

Before filing a bug, collect the extension version, Cursor version, operating system, whether the workspace is local or SSH, and the relevant diagnostic result. Remove private paths, chat text, and other sensitive content from logs. Please do not attach your full Cursor database or chat export to a public issue.

[Report a problem](https://github.com/oshokin/cursor-chat-transit/issues).

## Platform support

The extension targets desktop Linux, macOS and Windows. It runs in the local UI host even when the selected project is on SSH, in WSL or in a container. Install SQLite on the computer running the Cursor window.

| Client OS | Default Cursor data directory                                                |
| --------- | ---------------------------------------------------------------------------- |
| Linux     | `$XDG_CONFIG_HOME/Cursor` when XDG is absolute; otherwise `~/.config/Cursor` |
| macOS     | `~/Library/Application Support/Cursor`                                       |
| Windows   | `%APPDATA%\Cursor`; fallback `%USERPROFILE%\AppData\Roaming\Cursor`          |

For portable installs, custom `--user-data-dir` profiles or another Cursor channel, set `cursorChatTransit.userDataDir` explicitly. Automatic discovery does not cover every packaging method. Plans default to `~/.cursor/plans` on the client OS. Exported source-code paths are historical references and are not automatically mapped between operating systems.

SQLite must be executable on the client OS and architecture. Local filesystems with normal SQLite locking and hard-link support are the intended storage target; unusual network/removable filesystems may reject the safe no-overwrite resource write. Filesystem permissions and antivirus software can also prevent a write. The extension reports failures rather than bypassing checks.

The CI definition runs core tests on Linux, macOS and Windows. A configured matrix is not evidence that every Cursor version has passed a native smoke test; release notes should record the actual tested Cursor builds and systems. A `v*` tag builds one verified VSIX and opens a draft GitHub Release; Marketplace publishing remains a separate maintainer action.

## Data safety and compatibility

- Imports create SQLite backups of both target databases before writing new chat data. Backups remain in `cursor-chat-transit-backups` beside the global database until you remove them.
- Existing resource files are reused only when their contents match. Conflicting files are not overwritten.
- Concurrent metadata changes are checked before a write is committed. An interrupted write is reported as incomplete rather than silently accepted.
- Cursor's global and workspace databases are separate. Their updates cannot be treated as one crash-atomic transaction.
- Unknown write layouts are rejected. Cursor's private storage can change independently of the VS Code extension API.

Continuing an imported conversation depends on the Cursor version, conversation format, and availability of required data. Successful transfers have been manually checked by the maintainer, but that is not a compatibility guarantee for every Cursor release or every historical export.

Backups are a recovery aid, not an automatic rollback feature. Do not replace a live Cursor database while Cursor is running.

## Development

An optional [Taskfile](Taskfile.yml) provides short recipes over the npm scripts. The usual loop is `task setup` → `task check` → `task package`. `check` is compile, types, lint, format, and tests; `package` builds the VSIX. `task setup` installs Node from `.nvmrc` when npm is missing (Task does not load nvm from `~/.bashrc`; on Windows 10/11 it uses `scripts/dev-node.cmd`):

```sh
task setup
task check
task package
```

Run `task --list` for linting, formatting, unit/SQLite tests, watch mode and cleanup. `task node` prints the resolved toolchain. See the [development guide](docs/development.md) for version managers and the equivalent npm commands.

Use Node.js 24 and the local SQLite CLI. Once `node` and `npm` are on PATH:

```bash
npm ci
npm run check
```

`check` compiles the extension and sidebar, checks TypeScript, runs ESLint and Prettier, and executes the Node test suite. SQLite integration tests use temporary fixture databases.

F5 is the UI loop (`task watch`, reload the debug window). `task package` then **Install from VSIX** is the storage loop. Point `cursorChatTransit.userDataDir` at a copy of `User/` when a session must not write production databases. The isolated host does not generate Cursor chat databases.

Useful commands:

| Command                   | Purpose                                       |
| ------------------------- | --------------------------------------------- |
| `npm run watch`           | Rebuild the extension and sidebar as you edit |
| `npm run test:unit`       | Run tests that do not require SQLite          |
| `npm run test:sqlite`     | Run SQLite integration tests                  |
| `npm run test:host`       | Run the VS Code Extension Host smoke test     |
| `npm run lint:complexity` | Review long functions and branch-heavy code   |
| `npm run package`         | Build `dist/cursor-chat-transit.vsix`         |
| `npm run check-package`   | Inspect the packaged file inventory           |

See the [development guide](docs/development.md) for build, debug, CI, and release details. The [architecture document](docs/architecture.md) describes module responsibilities, import behavior, and the known Cursor storage contract.

## Contributing

Keep changes focused on one behavior or responsibility. Add regression tests for storage changes, preserve existing command and setting identifiers, and include the checks you ran in your pull request. If a change affects Cursor's private storage, document the supported structure and the fixture or manual scenario that demonstrates it.

Prefer small functions and cohesive modules over frameworks added for hypothetical future needs. Do not remove validation or change import behavior just to satisfy a line-count target.

## License

[MIT](LICENSE). The license retains the original copyright notice and includes the notice for subsequent work on Cursor Chat Transit.
