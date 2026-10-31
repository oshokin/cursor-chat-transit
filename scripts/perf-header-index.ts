import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { indexGlobalHeaders } from '../src/header-index';
import { matchesWorkspaceStorage, type HeaderSource } from '../src/db-headers';
import type { WorkspaceEntry } from '../src/types';

/** Synthetic benchmark scenario size and repetitions. */
const benchmarkWorkspaceCount = 1_000;
const benchmarkHeaderCount = 10_000;
const benchmarkIterations = 3;

/** Compare repeated global scans with operation-local indexing; synthetic metadata only. */
function main(): void {
  const sources: HeaderSource[] = [
    {
      source: 'blob',
      records: Array.from({ length: benchmarkHeaderCount }, (_, i) => ({
        composerId: `chat-${i}`,
        workspaceIdentifier: {
          id: `workspace-${i % benchmarkWorkspaceCount}`,
        },
      })),
    },
  ];

  const workspaces = Array.from(
    { length: benchmarkWorkspaceCount },
    (_, i) => ({ storageId: `workspace-${i}` }) as WorkspaceEntry,
  );

  for (let iteration = 1; iteration <= benchmarkIterations; iteration++) {
    let started = performance.now();

    const before = workspaces.map((workspace) =>
      sources[0].records
        .filter((row) =>
          matchesWorkspaceStorage(row, workspace.storageId, workspace.identity),
        )
        .map((row) => row.composerId),
    );

    const scanMs = performance.now() - started;

    started = performance.now();
    const lookup = indexGlobalHeaders(sources);

    const after = workspaces.map((workspace) =>
      lookup(workspace)[0].records.map((row) => row.composerId),
    );

    const indexedMs = performance.now() - started;

    assert.deepEqual(after, before);

    console.log(
      JSON.stringify({
        iteration,
        workspaces: benchmarkWorkspaceCount,
        headers: benchmarkHeaderCount,
        scanMs: Math.round(scanMs * 100) / 100,
        indexedMs: Math.round(indexedMs * 100) / 100,
        includesIndexConstruction: true,
      }),
    );
  }
}

main();
