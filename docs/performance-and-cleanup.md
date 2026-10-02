# Performance review and cleanup design

This review compares the supplied `cursor-chat-transit-20261002-120124.zip` with the accompanying changes. It does not claim that every extension operation is now maximally optimized.

## Evidence from the supplied log

The file contains 118,910 lines and 40,330,517 bytes. Its first timestamp is 12:11:05.073 and its last is 12:11:29.328, while the terminal operation reports 325,944 ms. It is a final fragment, not a complete profile of the five-minute operation. Earlier failures are not present, so its `incomplete` result cannot be diagnosed from this fragment alone.

There are 58,883 dependency-read starts and 58,883 completions: 117,766 lines, about 99.04% of the fragment. The starts reference 54,173 distinct keys across 67 chats; 4,710 reads repeat a key already seen in this fragment. Repeated content alone is not permission to retain every payload in RAM or cache it across mutable database views. The old filter was performing the full transfer-health check, even though its decision only needed proof of whether history was absent.

No OrderManager workspace URI appears in this fragment. The exact storage IDs involved in that report cannot be established from it. The duplicate enumeration mechanism is reproducible from the supplied code and covered by a synthetic regression test.

## Implemented changes

1. **Presence-only workspace filtering.** Check indexed message existence before reading a bounded composer record. Existing messages, indexed references, resource references, unsupported state, and read errors retain the workspace. Do not fetch attachment bytes or traverse conversation blob graphs merely to decide whether to hide a row. Every resolved chat is assessed.
2. **Short batched presence views.** Reuse a read view for up to 32 presence checks, then close it. No process is launched per chat in a workspace filter. Full chat-health checks continue to release their read view between chats.
3. **Byte-bounded dependency reads.** Export and checked chat selection request at most 32 keys per frontier. The reader probes lengths, reads a prefix totaling at most 4 MiB, and reads one larger supported record alone. The existing 32 MiB record ceiling and 1 MiB raw protocol chunks remain. Missing rows, empty blobs, text/blob identity, and required-versus-optional graph edges keep their semantics. Default graph readers used elsewhere remain single-record readers.
4. **Useful batch logs.** Each dependency batch records its database path and probed keys. Chat scope remains attached, and failed operations retain concrete identifiers. File operations continue to log their paths. Workspace count events also include the logical workspace key so a later log can identify a project as well as its storage directory.
5. **No unused inspection hashes.** Health inspection no longer computes a content hash that its sink discards. Export hashes and import checks remain in place.
6. **Bounded independent file reads.** Export inventory hashing and ZIP source inspection use at most `min(4, os.availableParallelism())` concurrent reads. Inventory output retains input order. Failed or cancelled batches drain all started reads before cleanup; later batches never start.
7. **Physical workspace binding.** Global headers with an explicit storage ID belong to that storage entry. A matching project URI cannot attach them to every older/newer storage directory at that path. URI-only headers remain a fallback, and explicit local lists remain visible. The separate import conflict rules are unchanged.
8. **Unambiguous Current label.** Use the extension host's workspace-storage location when available. Without it, a URI match is only decisive when exactly one storage entry matches. Never merge databases or mark several generations as current based only on their path.

These changes introduce no new settings, registry dependencies, archive version, database journal mode, persistent payload cache, or full-database copy.

## Validation

The complete package gate passed: compilation, type checks, ESLint, Prettier, and 439 tests with zero failures or skips (14 new regression tests). VSIX packaging completed. The new cases cover physical workspace binding, Current disambiguation, conservative presence checks, transaction release/cancellation, byte-bounded KV batches, graph traversal progress, ordered concurrent reads, and failure draining. Existing import/export, recovery, and corruption checks also pass. Interactive Cursor-host testing was not performed.

## Measurements

Node.js 24.21.0 and the same local SQLite executable were used for both versions. The statistics fixture has four chats with 2,048 shared, roughly 2 KiB dependencies each. Each chat has one indexed message. Both versions produce the same visibility/eligibility decisions.

| Operation              | Baseline median | Updated median | Observations                                           |
| ---------------------- | --------------: | -------------: | ------------------------------------------------------ |
| Workspace filter       |        2,448 ms |           9 ms | Dependency events: 16,384 → 0; all events: 16,432 → 33 |
| Checked chat selection |        2,564 ms |       1,872 ms | About 27% less time; dependency events: 16,384 → 512   |

Each median uses three sequential runs. Baseline filter runs: 2,723 / 2,286 / 2,448 ms; updated: 27 / 9 / 9 ms. Baseline selection: 2,372 / 2,564 / 2,646 ms; updated: 1,898 / 1,821 / 1,872 ms. This measures worker logic with an event counter, not the native Cursor Output panel or IPC rendering. It benefits from warm filesystem caches. The large filter speedup comes from removing unnecessary work on a blob-heavy fixture; it is not a universal multiplier or a measurement on the user's database.

An additional transfer smoke benchmark used 1,000 messages of 4,096 repeated bytes (4,096,000 logical payload bytes):

| Operation        |          Baseline |           Updated |
| ---------------- | ----------------: | ----------------: |
| Import           |            703 ms |            671 ms |
| Export           |            194 ms |            202 ms |
| Repeated import  |            303 ms |            204 ms |
| Sampled peak RSS | 130,842,624 bytes | 111,546,368 bytes |

Both runs imported one chat and created zero chats on repeat import. These single-run figures demonstrate completion, not a statistically established transfer speedup. Export was slightly slower in this small case. The import pipeline retains its integrity, receipt, conflict, and post-write checks; no import throughput improvement is claimed. Multi-gigabyte, attachment-heavy archives and actual Cursor-host interaction still require representative local measurements.

Reproduce with the pinned runtime after compilation:

```sh
npm run test:perf
CCT_BENCH_PROJECT=/path/to/compiled/baseline npm run test:perf
```

The tables above were taken with the individual scripts, not the combined defaults. The statistics rows use `scripts/perf-statistics.ts` at 4 chats and 2,048 blobs. The transfer rows use `CCT_BENCH_MESSAGES=1000 CCT_BENCH_MESSAGE_BYTES=4096 node --import tsx scripts/perf-bundle.ts`.

## Why not 32 concurrent chat jobs?

CPU availability is only one bound. These jobs share the same database, filesystem, and memory budget. Thirty-two readers can multiply decoded-record memory and hold overlapping read views without delivering a proportional gain. SQLite permits concurrent WAL readers, but long-running read views can delay checkpoint progress; writes to one database still serialize. Removing irrelevant work and batching small reads are the first steps. The small independent-file pool is deliberately capped. Raise it only after a representative benchmark shows a benefit with acceptable memory and editor responsiveness.

## Why multiple rows can legitimately remain

A storage ID and a project path are different identities. VS Code's folder-identity implementation includes the inode on Linux and creation-time information on other desktop platforms, so recreating a local directory can give the same path a new storage ID. This is an upstream explanation, not proof of the precise sequence that created a particular Cursor directory.

The old `id matches OR URI matches` enumeration rule could reproduce the same global chat list in both storage rows. Explicit-ID precedence resolves that case. Two rows may still share URI-only legacy headers or explicit local references, and equal counts can be coincidental. Keep those rows distinguishable; do not merge or delete them by display name, URI, or count. Global headers whose explicit storage ID no longer has a directory need a separate orphan-history discovery view, not reassignment to an arbitrary directory with a matching path.

The public Cursor repository does not provide the full editor implementation, and the uploaded archive does not contain the user's installed Cursor bundles. No claim is made that Cursor's closed implementation was fully audited. Community reports are supporting observations, not a stable storage contract.

## Next feature: a persistent Storage view

This is a proposal, not implemented deletion functionality. Keep the workspace picker focused on choosing a transfer source or destination. Add one **Manage storage** action that opens a persistent editor panel with Workspace and Chat views.

The first small release should provide:

- Analyze, inspect the reason for each result, and filter the result table.
- Group related paths visually while preserving each storage ID and database identity.
- Show orphan history separately from empty storage. Legacy and untitled chats are not cleanup candidates merely because of their label or format.
- Hide selected entries persistently in extension-owned state; show hidden entries and restore them in one action. Closing the panel must not erase results or cancel the background analysis. Stop remains explicit.
- Export selected history and open its operation report.

Persist only identities, timestamps, and results needed for the view. Revalidate stale results before applying a destructive action. Avoid payload caches and new background scans on every editor startup.

Actual deletion should be a separate increment with a preview of exactly what will be removed and why. A filter result is not a deletion authorization or proof that a whole workspace directory is disposable: it can contain UI state and other extensions' data. Distinguish removing an extension-list entry, removing chat bindings, deleting chat records, and deleting workspace storage. Do not combine them into one ambiguous button.

For physical workspace removal, require Cursor to be fully closed and prefer reversible quarantine with an explicit restore action. This would move only reviewed candidates; it must not reintroduce full global-database backups or store recovery data in an automatically cleaned temporary directory. For chat removal, re-read the selected records, account for shared/global references, and refuse unknown schemas or changed candidates. Do not garbage-collect `agentKv:blob:*` by chat or workspace alone: content can be shared, and a supported reference model is required before reclaiming it. VACUUM remains a separate maintenance action rather than a side effect of cleanup.

Recommended order: persistent Storage view and reversible hiding; orphan-history discovery/export; explicit supported chat deletion; physical storage cleanup last. This keeps each increment useful and reviewable.

## Sources and limits

- [VS Code folder identity implementation](https://github.com/microsoft/vscode/blob/main/src/vs/platform/workspaces/node/workspaces.ts): URI, inode/creation-time identity, and intentionally stable hashing rules.
- [VS Code ExtensionContext](https://code.visualstudio.com/api/references/vscode-api#ExtensionContext): workspace-specific extension storage.
- [SQLite WAL](https://www.sqlite.org/wal.html): read isolation, one writer, and checkpoint constraints.
- [Node.js availableParallelism](https://nodejs.org/api/os.html#osavailableparallelism): available parallelism differs from simply counting CPU entries.
- [Cursor public repository](https://github.com/cursor/cursor): publicly available repository contents and project links.
- [Cursor upstream transfer research](https://github.com/ibrahim317/cursor-chat-transfer/blob/main/docs/cursor-architecture-knowledge.md): observed header-to-storage bindings; independent research, not a Cursor contract.
- [Cursor community report: workspace changes after updates](https://forum.cursor.com/t/everytime-cursor-updates-the-workspace-does-weird-things/170969): user-reported behavior, not authoritative schema documentation.

Automated tests and synthetic benchmarks cannot certify every private Cursor format or a live user database. No publishing, production-data mutation, or physical workspace/chat deletion was performed.
