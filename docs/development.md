# Development

The implementation and storage contract are documented in [architecture.md](architecture.md). This page is the contributor guide.

## Prerequisites

- Node.js 24, pinned in `.nvmrc`. npm ships with that official Node.js build.
- sqlite3 CLI
- Cursor or VS Code for F5
- Optional: [Task v3](https://taskfile.dev/docs/installation)

Install Node with a version manager or let `task setup` download the official binary. Do **not** use distro `apt install npm` as the project toolchain: it is often old and is a different package from Node's bundled npm.

| Tool                                 | Why it works here                                                                                                                                     |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| [fnm](https://github.com/Schniz/fnm) | Fast, cross-platform, reads `.nvmrc`. `eval "$(fnm env)"` in `~/.bashrc` is enough for an interactive terminal, not for F5.                           |
| [nvm](https://github.com/nvm-sh/nvm) | Common on Linux/macOS; source `nvm.sh` in the **same** shell, then `nvm install`. Task and F5 do not load `~/.bashrc`.                                |
| [Volta](https://volta.sh/)           | Toolchain shims in `~/.volta/bin` on the **login** PATH. No `eval` hook; GUI apps can see `node` after a session restart.                             |
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

`task setup` reuses the exact Node.js version from `.nvmrc` when that build is already on PATH or installed by nvm, fnm, mise, Volta, or asdf. A different Node 24 is not reused. Otherwise it downloads that build from nodejs.org (SHA-256 checked) into `.tools/node`, then runs `npm ci`. Linux/macOS use `scripts/dev-node.sh`; Windows 10/11 use `scripts/dev-node.cmd` (PowerShell 5.1, no extra install). After that, `task build` and the other recipes call the same runner.

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

`task release:prepare` is the only local command that changes the version. Ordinary commits, amends, rebases, pushes, tests, and builds do not. It recommends a bump from Conventional Commits since the latest stable `vX.Y.Z` tag reachable from `HEAD`, then updates `package.json`, both version fields in `package-lock.json`, and prepends one `CHANGELOG.md` section. It does not commit, tag, push, or publish. `task release:preview` prints that plan and writes nothing. Pass `patch`, `minor`, `major`, or `X.Y.Z` after `--` to override the recommendation; a smaller bump than a breaking change still prints release-it's warning.

`git.tagMatch` is only a glob, so `.release-it.json` also sets `git.tagExclude` to `v*-*`. That drops prerelease tags such as `v1.0.0-beta` from the baseline. The `v` prefix keeps release-it's shell `git describe` from expanding the exclude pattern against files like `package-lock.json`.

```bash
task release:preview
task release:prepare
git diff -- package.json package-lock.json CHANGELOG.md
task check
git add package.json package-lock.json CHANGELOG.md
git commit -m "chore(release): 1.0.1"
git push
```

Edit the new changelog section before committing. CI publishes that text; it does not regenerate the changelog. The repository file stays `CHANGELOG.md`. vsce packs that file as `extension/changelog.md`, which is the name the Marketplace reads. The GitHub Release notes are that version's section plus short VSIX install steps.

CI publishes a push to the default branch when GitHub has no published release, or when `package.json` `version` is newer than the latest published release. A push whose version already matches that release does not publish again. Starting the same workflow with `publish_release=true` on the default branch publishes the recorded version even when the numbers already match. Pull requests are checks only. There is no Release PR bot. `v*` tag pushes are not a second publisher. The workflow summary lists the version and commit. A published run also links the release and names the VSIX. A matching published version says that the release was not requested and does not fail the workflow.

`1.0.0` is the initial version recorded in the source. The first push of that version to the default branch publishes it after the checks pass, because nothing is published yet. `release:prepare` refuses to invent the next number until tag `v1.0.0` exists on the reachable history. Do not create that tag by hand on an unverified commit.

Checks, SQLite, and the editor smoke test feed one `package` job. That job and `version-decision` feed **CI required**, and the release job hangs off that gate alone. Set the required status check name to **CI required** on `master`. The release job is skipped when this version is already published, so requiring it would stay pending. The workflow file cannot enable that rule by itself. The workflow trigger lists `master` because that is the repository default branch.

### First release and recovery

For the first release, push the reviewed implementation to `master`. The recorded version is published after the validation jobs and package job succeed, because no release is posted yet. No local release preparation is needed for the initial `1.0.0`. Run **Check and release** with `publish_release` only to publish again when that version is already posted. Keep the input disabled for a checks-only run.

| Situation                                                          | Developer action                                                                                                    |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Prepare produced an empty changelog section for a technical patch  | Write the user-facing notes before committing; CI rejects empty notes                                               |
| Fix or clarify notes before publication                            | Keep the prepared version and edit its existing section                                                             |
| CI failed before this version was published                        | Commit the fix without another bump and push to the default branch; CI publishes because that version is not posted |
| Upload or API failure, same code and artifact                      | Use **Re-run failed jobs** on the original run                                                                      |
| Draft already contains different bytes for this same commit        | Stop; retry the original publisher/artifact, never overwrite the existing asset                                     |
| Tag points at another commit and that version is already published | Do not move it; publish the next version instead                                                                    |
| Tag points at an older commit and that version is not published    | Push the same version; CI moves the tag, drops any leftover draft, and publishes                                    |
| Published release needs a fix                                      | Make a fix commit and prepare the next patch                                                                        |

Wait until GitHub shows a completed, published release before preparing the next version. The local guard checks Git tags; a tag can already exist while CI is still uploading a draft. A tag alone does not prove publication succeeded.

The changelog generator reads exactly the baseline-to-HEAD range without tag decorations. This prevents intermediate prerelease or unrelated tags from splitting the new stable section; the bump recommendation still comes from the pinned Conventional Commits plugin. Older changelog sections remain in place.

GitHub's tag-name endpoint returns only published releases. A new draft is read back by the id from the create response, because that tag lookup and a release list can both omit it. On a 404 for an existing tag, the publisher searches the authenticated, paginated release list, which includes drafts when the token can write. A 403/5xx is an error, never an empty list. Mock tests cover this distinction; real GitHub acceptance is still required before declaring deployment verified.

## Stale transfer lock

After a crash, use **Clear stale lock** when offered in the sidebar or error notification, then retry. The extension rechecks the recorded owner PID and token before removing that same `.lock` file. A live or changed owner is never removed. A lock whose owner cannot be verified needs inspection; opening the operation log shows its path. This action does not unlock SQLite, delete receipts, or modify Cursor's `state.vscdb`, `-wal`, or `-shm` files.

## Keeping the code understandable

Use one responsibility per module. There is no mandatory file-length limit. A long file is a review signal, not an automatic failure. Split it when responsibilities, dependencies or testing boundaries become clearer; do not split a coherent workflow merely to meet a number.

`npm run lint:complexity` reports functions above roughly 80 code lines or cyclomatic complexity 15. These are advisory project thresholds, not research-backed limits or release gates. Normal lint retains checks for correctness and asynchronous SQLite access.

Google's [code review guidance](https://google.github.io/eng-practices/review/reviewer/looking-for.html) evaluates whether readers can quickly understand the code and warns against unnecessary generalization. Prefer named phases and early returns where helpful. Do not add a framework, event bus or class hierarchy to lower a score.

## Refactor verification

Run the full test suite after moving storage code. Keep format versions, snapshot hashing, database transaction order and error semantics stable. `transfer.ts`, `db.ts` and `dependencies.ts` intentionally remain small public facades so callers do not all need to change.

The Node suite includes a minimal mocked VS Code contract test for command registration, shared operation locking and cancellation at the native UI boundary. It does **not** replace `npm run test:host` or a real Cursor session. Verify that all newly compiled modules are packaged; the VSIX include pattern remains flat `out/*.js` because these modules are flat under `src/`.

Before release, record the actual Cursor build and OS with the manual import/continue result. Automated fixtures do not establish compatibility with every Cursor version, remote workspace, or conversation format.

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
| `release:preview`                   | Show the recommended version and changelog draft; writes nothing       |
| `release:prepare`                   | Apply the recommended or explicit version bump to local files only     |
| `clean`                             | Remove `out/`, `dist/`, `coverage/`; preserve `.dev/` and dependencies |

Ordered steps use `cmds`, because Task dependencies run in parallel. `package` does not call `check` twice: `vsce` invokes `vscode:prepublish`, which already runs it. CI uses the same npm commands without requiring Task.

Core/integration tests fail up front when `sqlite3` is absent. Use `task test:unit` for the deliberately SQLite-free subset. On headless Linux, run `xvfb-run -a npm run test:host` for the host test.

On Windows 10/11, `task setup` downloads the official Node.js zip when npm is missing. The watch script runs TypeScript via Node.

Settings and command IDs use `cursorChatTransit.*`. File imports accept only version-4 ZIP archives. Import receipts are stored in SQLite.

## Opt-in performance checks

Compile, then run `npm run test:perf` or `task test:perf` with sqlite3 on PATH. It creates and removes only temporary fixture databases, then runs two benchmarks in order. Workspace filtering and checked chat selection use three repetitions; `CCT_BENCH_BLOBS` defaults to 2048 and `CCT_BENCH_CHATS` to 4. Import, export, and repeated import use `CCT_BENCH_MESSAGES` (default 3,000), `CCT_BENCH_MESSAGE_BYTES` (default 16 KiB), and `CCT_BENCH_RANDOM=1` for less-compressible payloads. `CCT_BENCH_PROJECT` points both benchmarks at another compiled checkout. Compare versions one after another on the same machine. A large transfer check can still start only the archive benchmark with `node --max-old-space-size=256 --import tsx scripts/perf-bundle.ts`; the V8 heap limit is not a process RSS limit.

Results include import/export/repeat durations, maximum batch transaction duration when instrumented, process peak sampled RSS, logical payload size and final ZIP bytes. Values describe this synthetic workload and machine; they do not predict every Cursor profile. RSS excludes SQLite child processes. The first archive creation is setup, not part of the import timing.

## Statistics development and acceptance

`statistics-picker.ts` owns the native QuickPick lifecycle without importing the VS Code runtime. `extension-statistics.ts` connects it to the existing worker and operation log. `statistics.ts` reads only the metadata needed for counts and format labels. Do not add automatic scans when a picker opens or change chat payloads to make a format label look compatible.

The tests cover opt-in execution, selection and focus preservation, cancellation, retry, late results, unknown formats, duplicate message references, corrupt metadata, and actual worker IPC against temporary SQLite databases. The sanitized legacy/Agent fixtures preserve the structural facts needed for counting, without private chat text.

Before shipping, verify the native experience in Cursor:

1. Open the workspace picker. Confirm that no analysis starts until the chart button is pressed.
2. Start a scan, filter the list, navigate with the keyboard, and select a workspace while work is in progress.
3. In the chat picker, change checkboxes during analysis. Confirm that results do not reset selection, filter text, or scroll position.
4. Stop and restart analysis. Close the picker while scanning, then reopen it; no old results should appear.
5. Check an untitled chat, an empty conversation, a legacy conversation, and an Agent conversation. Verify that unknown or unreadable metadata is never displayed as a measured zero.
6. Inspect Operations at `info` level. Confirm that file paths, chat IDs, counts, and the terminal outcome are present, with no message bodies.

Results are snapshots of the metadata read during the scan, not a live profile-wide transaction. Format detection does not certify that Cursor can continue a chat.

### Picker action acceptance

Check that the toolbar order is Statistics → Filter/Select, with only Stop available while work runs. Filter an empty workspace, show all again, and confirm no storage files change. A removed project path with surviving chats must remain available. A malformed record, missing dependency, or unreadable database must not cause history to disappear.

Verify checked selection with complete legacy history, a complete Agent chat, an empty chat, missing messages, and missing resources. Change checkboxes during the scan and confirm they are preserved. Cancel midway and confirm neither a partial filter nor a partial selection is applied. Verify keyboard navigation and group separators when every workspace is hidden.

In Extensions, inspect the transparent mark on light and dark themes and on a highlighted list row. In the Activity Bar, confirm the monochrome mark follows the host color and remains legible at the normal icon size.

### Performance regression checks

`npm run test:perf` includes this measurement: three repetitions of workspace filtering and checked chat selection on temporary databases, then the transfer benchmark. See [Opt-in performance checks](#opt-in-performance-checks) and [performance and cleanup](performance-and-cleanup.md).

For workspace identity regression checks, create two storage entries with the same URI and distinct global-header storage IDs. Each entry must receive its explicitly bound global chats. URI-only headers and local lists are retained as fallback evidence; never merge or delete storage based on the title, path, or equal counts.
