# Cursor Chat Transit

Move your Cursor chats between workspaces and devices.

Export selected conversations or a workspace's chat history to a ZIP archive, then import it into another Cursor workspace. An export includes supported messages, images, plans, canvases, and local conversation state. Importing the same snapshot again keeps the existing copy; importing a changed snapshot creates a separate conversation.

Cursor does not provide a way to move chats between workspaces. This extension does. Cursor's chat storage is a private format, not a public contract. A Cursor update can change that format and break export, import, or the ability to continue a chat. There is no promise that a new Cursor build will keep working with the current archive.

This is free software. You use it at your own risk. The author is not responsible for what you do with it, or for lost chats, damaged databases, or a Cursor update that stops an archive from importing. Backups are your responsibility. The extension does not make them for you.

## Features

- Find local, SSH, WSL, and container workspaces stored in your local Cursor profile.
- Count titled and untitled chats, and see whether a chat looks like a legacy or Agent conversation, before you export.
- Follow transfer stages, elapsed time, and measured progress in the sidebar.
- Preserve available message text in ZIP exports, including clearly labelled preview fragments and gaps when full bodies are missing.
- Find, check, and select chat history in a persistent native manager. Bulk history deletion runs as a normal extension operation after one confirmation; quit and reopen Cursor afterward.
- Recover usable history from an incomplete export after reviewing the missing data and confirming that import.

## Requirements and installation

You need a desktop Cursor or VS Code-compatible host with API version 1.125 or later, access to a local Cursor profile, and the `sqlite3` command-line executable. The extension runs on the local computer, including when the project is remote. Browser-only editors are not supported. VS Code can host the extension, but does not provide Cursor's native conversation interface.

Check SQLite with `sqlite3 --version`. Install it with your operating system's package manager or the [official SQLite tools](https://www.sqlite.org/download.html). If it is not on `PATH`, set `cursorChatTransit.sqlitePath` to its absolute path.

To install a release:

1. Download the `.vsix` asset from a [GitHub Release](https://github.com/oshokin/cursor-chat-transit/releases).
2. Open **Extensions → … → Install from VSIX…** in Cursor.
3. Select the package and reload if prompted.
4. Open **Cursor Chat Transit** in the Activity Bar.

No extension registry is required. To build your own VSIX, see [Development](docs/development.md).

## Export chats

1. Choose **Change…** in the sidebar to select the source workspace.
2. Select **Export chats**.
3. Export all chats or choose **Select chats…**.
4. Save the suggested `*.cursor-chat.zip` file.

The filename includes the workspace or selected chat name and a timestamp. If an export is incomplete, the result identifies the affected chats. Check the operation log before relying on that archive.

## Import chats

1. Select the destination workspace in the sidebar.
2. Choose **Import chats** and select a `*.cursor-chat.zip` archive.
3. Wait for the result.
4. If chats were added, choose **Quit Cursor**, then reopen Cursor to load them.

**Quit Cursor** closes the application through Cursor's own quit action. Cursor still handles confirmation and unsaved-work prompts. The extension does not start Cursor again. If the button is unavailable, quit from the application menu.

Imports create new local chat and message IDs and leave existing conversations in place. An import that changes nothing does not need a restart.

## Manage chats

Use the native **Manage chats** view to find workspaces and chats, check their data, and select history for deletion. Check a workspace to select its chats, or expand it and select individual chats. **Show all workspaces** and **Hide empty or unavailable workspaces** switch the same view without another scan. Export remains in the main transfer view.

**Export: Recover Text** is on by default in User Settings. The ZIP exporter keeps existing message records and can fill absent records with labelled previews or gaps in supported ordered conversations. It never replaces an existing empty message or repairs Cursor rendering. With the option off, available source records are still exported, but no replacement messages are created. The source is unchanged. Import asks for confirmation before publishing incomplete history. Open the imported chat in Cursor to use Cursor's own **Export Transcript**; this extension does not add a Markdown exporter. Compatibility with Cursor's transcript renderer must be checked on the Cursor version you use.

Use checkboxes for bulk deletion. With checked items, the trash action in either a row or the toolbar deletes the checked set. With no checked items, a row action deletes only that row; the toolbar asks for a selection. Native row highlighting does not change the checked set.

Before deletion, close other Cursor windows and stop running Agent tasks. Confirm the selection, wait for the result, then use **Quit Cursor** and reopen the IDE. Deletion keeps shared or uncertain records, project files, workspace storage directories and shared resources. It has no automatic undo or automatic backup and does not shrink the database file. The operation uses the existing worker and SQLite checks; it does not inspect operating-system processes or automatically quit Cursor.

## Further reading

Counts, format labels, picker filters, archive limits, repeat imports, settings, and troubleshooting are in [Usage](docs/usage.md). Setup and releases are in [Development](docs/development.md). Storage behavior is in [Architecture](docs/architecture.md).

[MIT](LICENSE), including the original copyright notice and the notice for subsequent work on Cursor Chat Transit.
