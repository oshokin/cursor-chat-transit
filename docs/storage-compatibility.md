# Local storage compatibility

The compatibility investigation targets installed Cursor **3.29.9**, build
`306d153d51d714882ab7b1bc49649cab624e8a30` (2026-11-05). Its bundled
`extensions/cursor-agent-host/dist/main.js` and `9690.js` are implementation
evidence, not a stable or public storage API. Support is limited to the structures
the extension explicitly validates; a version number alone does not establish
compatibility.

`scripts/extract-installed-tool-schemas.ts` extracts the checked-in
`src/cursor-tool-schemas.json` registry from that installed host bundle:
72 ToolCall variants, 551 reachable schemas, and 1,663 fields. Compilation copies
the registry into `out/`, and package verification requires it in the VSIX.
Unknown future fields and malformed declared wrappers are explicitly unsupported,
not silently accepted as complete dependency closure. Registry coverage does not
establish support for every Cursor feature or backend operation.

The inspected local global database exposes `ItemTable`, `cursorDiskKV`,
`composerHeaders`, and `remoteAgentHeaders`. The last is a remote-session catalogue
(`sessionId`, `hostKey`, `updatedAtMs`, `value`), not evidence that its remote
session can be exported as a local host store. Unknown tables and remote/backend
state are not copied or removed merely because they mention the same identifier.
The inspected native profile-global `data.sqlite` exposes `ItemTable` and
`cursorDiskKV`; no per-session `session.sqlite` files were found in that inspected
profile. Native-session regressions therefore use synthetic fixtures, not a claim
that real host-owned conversations were exercised.

## Safety boundary

Real profile investigation uses ordinary read-only SQLite connections so committed
WAL pages remain visible. Do not use `immutable=1` against a running profile. Schema
and record-family counts are sufficient for inventory; conversation values and
private resource contents must not be printed. Automated regression tests use
synthetic temporary databases, not imports into or deletions from a real profile.

An exact local copy is not a recreation of account, backend, model, or remote Agent
state. Neither a successful import nor a successful export/import round trip proves
that Cursor can continue an Agent conversation.

## Explicitly bounded support

- Renderer state accepts canonical hex and `~`-prefixed base64. Protobuf identity
  remapping follows evidenced subagent map-key fields, not arbitrary UUID-shaped
  strings. Message text and unknown fields are not searched and replaced.
- Blob discovery follows typed descriptors. An unrelated 32-byte value is not a
  dependency merely because a blob with that digest happens to exist. Unsupported
  tool-call closure is reported instead of recursively scanning arbitrary bytes.
  The installed host's module 91033 and generated wrappers establish supported
  read-tool success data/content, truncated original steps and previews, and
  selected image/video/document, invocation, extra-context, external-link,
  pull-request and diff blob references. Wrapper depth and field counts are
  bounded; malformed IDs, ambiguous oneofs and unimplemented tool variants fail
  closed. This is not support for every Cursor tool or future descriptor.
- Native snapshots validate content hashes, supported roots, manifest/list ranges,
  and the renderer root binding. A lagging listing sidecar is not the authoritative
  root. Structured native closure without a complete supported codec is rejected;
  no protobuf/CAS identities are synthesized or broadly rewritten.
  Unsupported native codecs are distinct from corrupt snapshots. Renderer-only
  history fallback requires a present supported renderer state with no missing
  closure blobs, and reports the omitted native component. Corruption remains
  fatal and cannot trigger that fallback. Read-only checks apply the same rule.
- Supported visualization HTML is transferred as opaque resources, never parsed
  or executed. See [Artifact support and limitations](artifacts.md) for reference
  discovery, platform restrictions, safe provisioning, and historical terminal snapshots and
  external transcript support. Images, plans and canvases retain their separate supported
  resource contracts.
- Native publication records recoverable exact bytes and hashes before renderer
  publication. Recovery refuses changed or occupied destinations instead of
  overwriting foreign sessions. Header-only renderer catalogue entries also count
  as occupied IDs.
- Deletion retains unknown/shared native stores and remote state. Conflicting
  workspace ownership does not become exclusive ownership just because one
  catalogue source matches the selected workspace.

## Manual acceptance

Use a disposable Cursor profile and workspace, with explicit consent to modify
them. Keep the source profile unchanged.

1. Prepare synthetic open and closed chats, a parent/subagent family, and available
   image, plan, and canvas resources. Include both renderer-owned and, when the
   installed Cursor creates one, committed host-owned sessions.
2. Export and import into a different disposable workspace. Inspect messages,
   ordering, family links, and resource availability. Review any unsupported or
   incomplete-state warning; do not interpret preserved opaque bytes as decoded
   state.
3. Fully quit Cursor and reopen the destination. Inspect the same history and
   resources again; a window reload is not a substitute for process shutdown.
4. Separately and voluntarily send a new synthetic message to test continuation.
   Record this independently from local-byte integrity and rendering results.
5. Exercise repeat import, an occupied destination ID, and interrupted-import
   recovery only in the disposable profile. Existing or unknown session stores
   must remain untouched.

The automated suite does not perform these manual checks or send messages. Do not
claim native rendering, post-restart cache behavior, or Agent continuation until
those acceptance steps have actually been completed.
