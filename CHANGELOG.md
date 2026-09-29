# Changelog

## 1.0.0

First release of Cursor Chat Transit (`oshokin.cursor-chat-transit`).

- Export and import Cursor chats between workspaces and devices, including conversation records, plan files, attachments, and referenced blobs.
- Repeat import skips an identical previously imported snapshot and adds a separate copy when the source changed; it does not overwrite an existing chat.
- Restore a deleted imported chat as a new independent copy when a verified receipt still points at leftover SQLite rows without a workspace list binding; keep those leftover rows and still refuse unfinished pending imports.
- Show **Quit Cursor** only after a completed import adds chats, including usable chats recovered from an incomplete export; it uses Cursor's normal quit command, with confirmation and unsaved-work prompts handled by Cursor.
- Remove the extension's redundant quit confirmation. Keep the native quit flow and protect against duplicate requests and state changes during command lookup.
- List chats by recent activity and group workspaces by location, with the current workspace first.
- Rename settings, commands and views to `cursorChatTransit.*`; previous keys and custom keybindings must be updated manually.
- Add local plans-directory and bounded SQLite timeout settings; apply lock waits to writes and backups as well as reads.
- Fail closed on leftover transfer locks; make lock release idempotent so an old handle cannot delete a new owner's file.
- Distinguish leftover locks from a live operation and put recovery steps in the operation log.
- Show the sidebar progress bar only while a transfer is running; native pickers wait without a progress bar or a premature “reading” message.
- Remove a stray `>` between the operation-log and cancel controls.
- Retain the original MIT copyright notice alongside the notice for subsequent work on Cursor Chat Transit; clarify provenance in the architecture document.
- Draft GitHub Release from a `v*` tag after the same CI gates; no Marketplace publish.
- Pin `@types/vscode` to 1.85.0 to match `engines.vscode`.
- `task setup` installs the Node.js version from `.nvmrc` when npm is missing. Linux/macOS use a POSIX script; Windows 10/11 use PowerShell 5.1.
- Drop the synthetic F5 chat databases and editor launchers. Debug with an empty isolated host; dogfood by installing the VSIX into Cursor.
- Route F5 compile/watch through the same Node wrapper as Task, so the desktop GUI PATH is not required.
- Keep npm stdout out of the Windows wrapper's exit code; smoke `dev-node` on the CI OS matrix.
- Add Task recipes; improve file URI metadata and portable VSIX verification.
- Remove the mandatory file-length lint limit; retain advisory function-complexity review.
- Drop unused Task recipes `review`, `test:watch`, and `test:host`; the npm scripts remain.
