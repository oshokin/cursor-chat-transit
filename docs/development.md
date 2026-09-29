# Development

The combined design record — modules, product language, repeat-import policy, and the Cursor storage contract — is [architecture.md](architecture.md). This page is the contributor guide.

## Prerequisites

- Node.js 24, pinned in `.nvmrc` (audit used 24.19.0). npm ships with that official Node.js build.
- sqlite3 CLI
- Cursor or VS Code for F5
- Optional: [Task v3](https://taskfile.dev/docs/installation)

Install Node with a version manager or let `task setup` download the official binary. Do **not** use distro `apt install npm` as the project toolchain: it is often old and is a different package from Node's bundled npm.

| Tool                                 | Why it works here                                                                                                                                     |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| [fnm](https://github.com/Schniz/fnm) | Fast, cross-platform, reads `.nvmrc`. `eval "$(fnm env)"` in `~/.bashrc` is enough for an interactive terminal, not for F5.                           |
| [nvm](https://github.com/nvm-sh/nvm) | Common on Linux/macOS; source `nvm.sh` in the **same** shell, then `nvm install`. Task and F5 do not load `~/.bashrc`.                                |
| [Volta](https://volta.sh/)           | LinkedIn-style shims in `~/.volta/bin` on the **login** PATH. No `eval` hook; GUI apps can see `node` after a session restart.                        |
| Official tarball                     | [nodejs.org/download](https://nodejs.org/en/download); `task setup` unpacks it into gitignored `.tools/node` (Linux/macOS tarball, Windows 10/11 zip) |

Cursor's helper `node` (`…/resources/helpers/node`) is not a development toolchain: it has no `npm`.

F5 and the workspace **Run Task** entries call `scripts/dev-node.sh` / `dev-node.cmd`, the same resolver as Task. They do not use VS Code's `type: npm` runner, which inherits the desktop GUI `PATH` and [does not source shell startup files](https://code.visualstudio.com/docs/debugtest/tasks#_why-do-i-get-command-not-found-when-running-a-task). After `task setup`, compile works even when Cursor was started from a menu.

A version manager helps every GUI app on the machine only when its shims are on the **session** PATH (Volta; official Node installer; Linux `~/.config/environment.d/`). Putting `nvm` or `fnm env` solely in `~/.bashrc` is not that. Do not add login-shell flags (`bash -l`) to tasks: Microsoft documents that as a one-off, not the recommended fix.

If nvm lines are already in `~/.bashrc` but `~/.nvm` does not exist, nvm was never installed. Either run `task setup` or install fnm/nvm and `nvm install` from `.nvmrc`.

The usual loop is `task setup` → `task check` → `task package`:

```bash
task setup
task check
task package
```

`check` is compile, types, lint, format, and core tests. `package` builds and inventories the VSIX. Split recipes (`build`, `lint`, `test`, …) are listed below.

`task setup` reuses Node 24 + npm when they are already on PATH, otherwise downloads the `.nvmrc` build from nodejs.org (SHA-256 checked) into `.tools/node`, then runs `npm ci`. Linux/macOS use `scripts/dev-node.sh`; Windows 10/11 use `scripts/dev-node.cmd` (PowerShell 5.1, no extra install). After that, `task build` and the other recipes call the same runner.

Equivalent without Task, once Node is on PATH:

```bash
npm ci
npm run check
```

`npm run check` is compile + typecheck + lint + format + tests.

TypeScript sources live in `src/` and compile to `out/`. The sidebar client compiles from `webview/` to `resources/sidebar-client.js`. `npm run watch` (or the VS Code **watch** task) rebuilds both. Tests and scripts run with `tsx`. `tsc -p tsconfig.check.json` typechecks scripts and tests. Node tests live in `test/*.test.ts`; `*.sqlite.test.ts` needs the sqlite3 CLI. `test/host` is the VS Code smoke runner.

## Debug loops

The debug host uses `.dev/host-data` so extension-host settings do not mix with your daily Cursor profile. It does not invent Cursor chat databases.

**UI.** `task watch`, then F5 (**Extension: isolated profile**). After a change, reload the debug window. Breakpoints map through `out/**/*.js`. The sidebar is a webview: use its developer tools, not the extension-host debugger.

**Storage.** `task package`, then **Install from VSIX** in the Cursor you actually use. That is the check that the live layout and the VSIX contents still work. F5 is not a substitute.

The extension discovers the real local Cursor user-data directory unless you set `cursorChatTransit.userDataDir`. Point that setting at a **copy** of `User/` if a debug session or a VSIX install must not write production databases.

## Scripts

| Script              | Purpose                                         |
| ------------------- | ----------------------------------------------- |
| `npm run compile`   | `tsc` → `out/` and sidebar client               |
| `npm run typecheck` | noEmit check of src, scripts, and tests         |
| `npm test`          | all Node tests (`--unit` / `--sqlite` to split) |
| `npm run test:host` | VS Code smoke (`@vscode/test-electron`)         |
| `npm run package`   | VSIX into `dist/`                               |

## Packaging

`package.json#files` is the allowlist (`out/*.js`, resources, README, changelog and license). `src/`, `tmp/`, tests, `.dev`, and user DBs must not enter the VSIX. `npm run check-package` inventories the ZIP with the direct development dependency `yauzl`, checks every source module has compiled output in the VSIX, and rejects development data. No external `unzip` is required.

## Release

Pushing tag `v*` runs the same CI gates, builds one VSIX, writes `SHA256SUMS`, and opens a **draft** GitHub Release with those two files. That is not Marketplace or Open VSX publishing. After the draft exists:

1. Download the VSIX from the draft (the same artifact CI already verified).
2. Install it in the real Cursor you use and smoke export/import locally and, when relevant, over Remote SSH.
3. Publish the GitHub Release only after that check. A new version is a new tag; do not replace a published VSIX.

Set the required status check name to **CI required** on `main` so a skipped dependent job cannot look green. The workflow file cannot enable that rule by itself.

## Stale transfer lock

After a crash, Cursor Chat Transit may refuse a new export or import because `transfer.lock` is still in the extension global-storage directory. A live owner is reported as `LOCKED`. A leftover file is `LOCK_RECOVERY_REQUIRED`: the operation log lists the path and recovery steps. Close every Cursor window that uses that storage, confirm the recorded pid is gone, then delete **only** that named `.lock` file. Do not delete import journals, receipts, backups, or Cursor databases. Quitting Cursor does not delete the lock. Then open Cursor and retry. This is a rare recovery step, not a prompt on every import.

## Keeping the code understandable

Use one responsibility per module. There is no mandatory file-length limit. A long file is a review signal, not an automatic failure. Split it when responsibilities, dependencies or testing boundaries become clearer; do not split a coherent workflow merely to meet a number.

`npm run lint:complexity` reports functions above roughly 80 code lines or cyclomatic complexity 15. These are advisory project thresholds, not research-backed limits or release gates. Normal lint retains checks for correctness and asynchronous SQLite access.

Google's [code review guidance](https://google.github.io/eng-practices/review/reviewer/looking-for.html) evaluates whether readers can quickly understand the code and warns against unnecessary generalization. Prefer named phases and early returns where helpful. Do not add a framework, event bus or class hierarchy to lower a score.

## Refactor verification

Run the full test suite after moving storage code. Keep format versions, snapshot hashing, database transaction order and error semantics stable. The explicit Transit namespace change updates settings, commands, views and tests together; it does not migrate import receipts or exported chat data. `transfer.ts`, `db.ts` and `dependencies.ts` intentionally remain small public facades so callers do not all need to change.

The Node suite includes a minimal mocked VS Code contract test for command registration, shared operation locking and cancellation after module extraction. It does **not** replace `npm run test:host` or a real Cursor session. Verify that all newly compiled modules are packaged; the VSIX include pattern remains flat `out/*.js` because these modules are flat under `src/`.

Before release, record the actual Cursor build and OS with the manual import/continue result. The maintainer's successful 2026-09-29 transfer is valid smoke evidence; avoid converting it into an unsupported claim that every Cursor version, SSH setup and historical export is compatible.

## Task recipes

[Task](https://taskfile.dev/docs/installation) is optional. Each recipe still delegates to an npm script. Run `task` or `task --list` to see the commands. Recipes invoke `scripts/dev-node.sh` or `scripts/dev-node.cmd` so `npm` is found even when this terminal did not source nvm.

The contributor loop is `task setup` → `task check` → `task package`. `task node` prints the resolved toolchain.

| Recipe                              | Purpose                                                                |
| ----------------------------------- | ---------------------------------------------------------------------- |
| `setup`                             | Install Node from `.nvmrc` if needed, then locked `npm ci`             |
| `node`                              | Print the Node.js and npm that Task will use                           |
| `build`, `watch`                    | Compile once or continuously                                           |
| `typecheck`, `lint`, `format:check` | Read-only quality checks                                               |
| `format`                            | Apply formatting                                                       |
| `test`, `test:unit`, `test:sqlite`  | Core tests and filtered suites                                         |
| `check`                             | Local pre-commit validation                                            |
| `package`                           | Validate, build and inspect the VSIX; does not publish                 |
| `clean`                             | Remove `out/`, `dist/`, `coverage/`; preserve `.dev/` and dependencies |

Ordered steps use `cmds`, because Task dependencies run in parallel. `package` does not call `check` twice: `vsce` invokes `vscode:prepublish`, which already runs it. CI uses the same npm commands without requiring Task.

Core/integration tests now fail up front when `sqlite3` is absent. Use `task test:unit` for the deliberately SQLite-free subset. On headless Linux, run `xvfb-run -a npm run test:host` for the host test.

On Windows 10/11, `task setup` downloads the official Node.js zip when npm is missing. The watch script runs TypeScript via Node.

Settings and command IDs now use `cursorChatTransit.*`. There are no legacy aliases. Set any previously customized values under the new keys and update custom keybindings. Existing user chat exports and journal formats are unchanged.
