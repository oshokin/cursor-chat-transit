# Artifact support and limitations

Archives can include supported images, plans, canvases, and visualization HTML.
These are separate resource contracts, not a backup of every file mentioned in a
conversation. See [Usage](usage.md) for transfer workflows and
[Storage compatibility](storage-compatibility.md) for the investigated Cursor
build, safety boundary, and manual acceptance checklist.

## Visualization HTML

Visualization references use the installed renderer's `kind="visualization"`
and `src` contract (including structured `attribs`/`properties`) or recognized
tool path fields. Arbitrary message text and unrelated paths do not establish
resource ownership. Missing referenced HTML is reported as incomplete.

Structured visualization HTML references are carried as opaque resources in v5
archives requiring `visualization-html-v1`. HTML is never parsed or executed by
the transfer. Files are limited to 1.5 MiB, read without following file symlinks,
and installed without replacing different bytes. They belong to the destination
composer's agent-store `files/visualizations` directory, not the workspace canvas
directory.

Export checks the current composer, side-chat parent, and nearest project
ancestor; import always installs into the target composer's own scope. Offline
callers can provide `resolveVisualizationScopeFiles` for project, peer, or
nonstandard agent-store scopes. Callback overrides are in-process APIs and are
not serialized to transfer workers. Workers use read-only local resolution,
never Cursor mount or sync commands. Export never creates directories.

## Platform support and provisioning

Persistent Linux (including absolute XDG state overrides), macOS, and Windows
read layouts and the explicit absolute `CURSOR_AGENT_STORE_DIR` override are
supported. Temporary fallbacks and unknown platforms are not guessed.

Import can create a clean private current-user Linux/macOS store namespace; it
refuses insecure or foreign-owned roots without changing their permissions.
Windows import provisions new directories using the installed Cursor backend's
`icacls /inheritance:r /grant:r` contract: explicit inheritable Full Control for
the current-user SID, SYSTEM (`S-1-5-18`), and Administrators (`S-1-5-32-544`).
ACLs (access control lists) are Windows' per-principal permissions, not POSIX mode
bits. Removing inheritance prevents broader parent grants from leaking into the
store; it does not repair pre-existing explicit grants. Accordingly, existing
insecure stores are refused without permission changes. PowerShell reads numeric
SIDs and verifies current-user ownership, a protected ACL, and exactly those three
allow entries with child inheritance. Reparse points, including junctions, are
rejected. Security tools use absolute SystemRoot paths, argument arrays without a
shell, encoded scripts with base64 path literals, bounded output and 10-second
per-process deadlines. Missing tools, timeout and unverifiable ACLs fail closed.

Windows behavior has platform-mocked tests on Linux, not live Windows validation.
Before declaring native Windows compatibility verified, test clean/reused stores,
localized accounts, junctions, ACL denial and NTFS permission inheritance on a
Windows machine. Path-based checks cannot make directory creation and ACL changes
atomic against a concurrent malicious local filesystem actor; initial mkdir may
briefly inherit parent permissions before the ACL is tightened.

Provisioning failures remove only empty directories created by that attempt
whose filesystem identity is unchanged. Existing directories, nonempty partial
results, and Cursor-owned metadata are retained for safe retry. This is not a
rollback of a committed chat or deletion of successfully installed resources.

Local provisioning follows Cursor 3.29.9's pre-sync files-directory handout;
it does not copy or synthesize `.sync/root-id`, owner/mount metadata, locks, or
sync indexes. Cursor owns later mount admission, recovery, cloud synchronization,
and renderer availability; a successful byte transfer does not prove those live
services are available.

## Terminal dumps and agent transcripts

Format-5 archives require `historical-artifacts-v1` for these resources. Transcript
ownership comes from the composer database and `subagentInfo.parentComposerId`,
never JSONL contents or arbitrary filenames. All existing canonical, legacy flat,
and nested subagent JSONL/TXT variants are copied byte-for-byte; destination paths
use assigned composer/parent IDs. Encoding/truncation collisions are rejected.
Missing transcript derivatives are not regenerated.

Only structurally explicit terminal file mentions and shell-result snapshot
references beneath the owning project's `terminals` directory are collected.
The directory is never scanned wholesale. Snapshots are installed under
`chat-transit-history/<destination-composer>/terminal-snapshots`, outside Cursor's
live terminal cleanup directory. Recognized exported references retain file-URI
form and line suffixes. Missing snapshots and live terminal mentions remain
external and produce diagnostics; no process, PTY, shell or live URI is recreated.

Files are bounded to 16 MiB each, read using stable identity checks, and installed
with journaled no-clobber semantics. Existing symlink ancestors are refused. Local
path checks do not provide atomic protection against a hostile concurrent actor
replacing ancestor directories. Offline APIs may override the default workspace
project root with `projectArtifactsDir`.
