# Cursor Chat Transit

Move Cursor chats between workspaces and devices. Export selected conversations, or a workspace's chat history, to a `*.cursor-chat.zip` archive and import it into another workspace. An archive can include supported messages, images, plans, canvases, and local conversation state. The same snapshot is imported once. A changed snapshot becomes a separate conversation.

Cursor's chat storage is private. A Cursor update can break export, import, or the ability to continue a chat. An archive can contain prompts, source, tool output, paths, and secrets. Treat it as sensitive. This extension does not back up your profile. You use it at your own risk.

## Install

Install **Cursor Chat Transit** (`oshokin`) from a registry, or from a GitHub Release:

- [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=oshokin.cursor-chat-transit)
- [Open VSX Registry](https://open-vsx.org/extension/oshokin/cursor-chat-transit)
- [GitHub Releases](https://github.com/oshokin/cursor-chat-transit/releases) — download the `.vsix`, then **Extensions → … → Install from VSIX…**

Source and issues: [github.com/oshokin/cursor-chat-transit](https://github.com/oshokin/cursor-chat-transit).

You need a desktop Cursor or VS Code-compatible host with API 1.128 or later, a local Cursor profile, and a runtime that supports Node-API 10. The extension runs on the local computer, including when the project is remote. SQLite is inside the VSIX. VS Code can host the extension. It does not provide Cursor's conversation UI. Building from source is in [Development](docs/development.md).

## Use

Open **Cursor Chat Transit** in the Activity Bar. **Change…** selects the workspace. **Export chats** writes a ZIP. **Import chats** reads one. If chats were added, choose **Quit Cursor**, then reopen Cursor. **Manage chats** finds, checks, exports, imports, and deletes local history. Its workspace-row import action always targets that workspace. Checked chats or whole workspace rows can be exported from several workspaces into one ZIP; importing that ZIP still copies all included chats into one destination workspace.

A successful import keeps local bytes. It does not prove that Cursor can resume an Agent. Settings, limits, host-owned sessions, and the continuation check are in [Usage](docs/usage.md). Storage behavior is in [Architecture](docs/architecture.md).

## License

[MIT](LICENSE).
