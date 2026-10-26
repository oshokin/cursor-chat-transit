import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { familyImportAdjustments } from '../src/chat-family';
import type { Plan } from '../src/import-bundle-common';
import {
  adjustFamilyPlan,
  type CatalogFamilyRow,
} from '../src/import-family-plan';
import { listWorkspaceEntries, listWorkspaceEntriesAsync } from '../src/paths';

/**
 * Same-process comparison of the previous family-plan filters and the sync
 * inventory with the indexed plan and the async inventory. Temporary files only.
 */
async function main(): Promise<void> {
  const cpu = os.cpus()[0];

  console.log(
    JSON.stringify({
      kind: 'environment',
      node: process.version,
      platform: process.platform,
      cpus: os.cpus().length,
      cpu: cpu?.model,
      ramBytes: os.totalmem(),
    }),
  );

  await measureInventory();
  measureFamilyPlan();
}

/** Wall time and event-loop delay for sync and async profile listings. */
async function measureInventory(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cct-inventory-bench-'));

  try {
    for (const count of [100, 1000, 5000]) {
      const userDir = path.join(root, String(count));
      const storage = path.join(userDir, 'User', 'workspaceStorage');

      await fs.mkdir(storage, { recursive: true });

      for (let index = 0; index < count; index++) {
        const folder = path.join(storage, `storage-${index}`);

        await fs.mkdir(folder);
        await fs.writeFile(path.join(folder, 'state.vscdb'), '');

        await fs.writeFile(
          path.join(folder, 'workspace.json'),
          JSON.stringify({ folder: `file:///tmp/project-${index % 20}` }),
        );
      }

      const syncIds = listWorkspaceEntries(userDir).map(
        (entry) => entry.storageId,
      );

      const asyncIds = (await listWorkspaceEntriesAsync(userDir)).map(
        (entry) => entry.storageId,
      );

      assert.deepEqual(asyncIds, syncIds);

      const sync = await samples(7, () => {
        listWorkspaceEntries(userDir);
      });

      const asyncSamples = await samples(7, async () => {
        await listWorkspaceEntriesAsync(userDir);
      });

      console.log(
        JSON.stringify({
          kind: 'inventory',
          storages: count,
          sync: sync.wall,
          syncEventLoopMaxMs: sync.delayMaxMs,
          async: asyncSamples.wall,
          asyncEventLoopMaxMs: asyncSamples.delayMaxMs,
        }),
      );
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

/** Indexed family adjustment versus the previous per-row find and filter. */
function measureFamilyPlan(): void {
  const rows = familyRows(4000);
  const original = seedPlan(rows);
  let sequence = 0;

  const nextId = () => {
    sequence += 1;

    return `id-${sequence}`;
  };

  const expected = structuredClone(original);

  sequence = 0;
  baselineAdjust(rows, expected, nextId);
  const actual = structuredClone(original);

  sequence = 0;
  adjustFamilyPlan(rows, actual, nextId);
  assert.deepEqual(actual, expected);

  const before = syncSamples(() => {
    sequence = 0;
    baselineAdjust(rows, structuredClone(original), nextId);
  });

  const after = syncSamples(() => {
    sequence = 0;
    adjustFamilyPlan(rows, structuredClone(original), nextId);
  });

  console.log(
    JSON.stringify({
      kind: 'family-plan',
      rows: rows.length,
      before,
      after,
    }),
  );
}

/** Previous drop and promote loops, kept only as the comparison baseline. */
function baselineAdjust(
  rows: readonly CatalogFamilyRow[],
  plan: Plan,
  allocateId: () => string,
): void {
  const adjusted = familyImportAdjustments(rows);

  for (const sourceId of adjusted.drop) {
    const row = rows.find((item) => item.sourceId === sourceId);

    if (!row) continue;
    plan.create = plan.create.filter((ordinal) => ordinal !== row.ordinal);

    plan.newVersions = plan.newVersions.filter(
      (item) => item.composerId !== sourceId,
    );

    plan.restored = plan.restored.filter(
      (item) => item.composerId !== sourceId,
    );

    plan.skipped.push({
      composerId: sourceId,
      name: row.name,
      reason: 'The parent chat is not in this archive.',
    });
  }

  for (const sourceId of adjusted.promote) {
    const row = rows.find((item) => item.sourceId === sourceId);

    if (!row) continue;
    allocateId();
    plan.already = plan.already.filter((item) => item.composerId !== sourceId);
    plan.create.push(row.ordinal);

    plan.newVersions.push({
      composerId: sourceId,
      name: row.name,
      reason: 'A subagent changed; a new conversation family will be created',
    });
  }
}

/** Mixed skip, create, and missing-parent rows. */
function familyRows(count: number): CatalogFamilyRow[] {
  const rows: CatalogFamilyRow[] = [];

  for (let index = 0; index < count; index++) {
    const sourceId = `chat-${index}`;
    const missing = index % 5 === 0;
    const child = index % 2 === 1;

    rows.push({
      sourceId,
      ordinal: index,
      name: sourceId,
      decision: child || missing ? 'create' : 'skip',
      targetId: `dest-${index}`,
      hash: `hash-${index}`,
      header: {
        composerId: sourceId,
        name: sourceId,
        subagentComposerIds: child ? undefined : [`chat-${index + 1}`],
        subagentInfo: child
          ? { parentComposerId: missing ? 'absent' : `chat-${index - 1}` }
          : undefined,
      },
    });
  }

  return rows;
}

/** Plan arrays the scanner would have filled before family adjustment. */
function seedPlan(rows: readonly CatalogFamilyRow[]): Plan {
  const plan: Plan = {
    create: [],
    skipped: [],
    already: [],
    repair: [],
    newVersions: [],
    restored: [],
  };

  for (const row of rows) {
    if (row.decision === 'skip') {
      plan.already.push({
        composerId: row.sourceId,
        name: row.name,
        targetComposerId: row.targetId,
        reason: 'already imported',
      });

      continue;
    }

    plan.create.push(row.ordinal);

    if (row.ordinal % 5 === 0) {
      plan.restored.push({
        composerId: row.sourceId,
        name: row.name,
        reason: 'restored copy',
      });
    } else {
      plan.newVersions.push({
        composerId: row.sourceId,
        name: row.name,
        reason: 'updated version',
      });
    }
  }

  return plan;
}

/** Two warm-ups and seven timed calls, with the event-loop delay of the samples. */
async function samples(
  count: number,
  run: () => void | Promise<void>,
): Promise<{
  wall: { medianMs: number; minMs: number; maxMs: number; rangeMs: number };
  delayMaxMs: number;
}> {
  for (let index = 0; index < 2; index++) await run();
  const delay = monitorEventLoopDelay({ resolution: 20 });
  const walls: number[] = [];

  delay.enable();

  for (let index = 0; index < count; index++) {
    const started = performance.now();

    await run();
    walls.push(performance.now() - started);
    await new Promise((resolve) => setImmediate(resolve));
  }

  await new Promise((resolve) => setImmediate(resolve));
  delay.disable();

  return { wall: summarize(walls), delayMaxMs: Math.round(delay.max / 1e6) };
}

/** Seven timed synchronous calls after two warm-ups. */
function syncSamples(run: () => void): {
  medianMs: number;
  minMs: number;
  maxMs: number;
  rangeMs: number;
} {
  for (let index = 0; index < 2; index++) run();
  const walls: number[] = [];

  for (let index = 0; index < 7; index++) {
    const started = performance.now();

    run();
    walls.push(performance.now() - started);
  }

  return summarize(walls);
}

/** Median and the min-to-max range. Seven samples are not a tail-latency estimate. */
function summarize(samples: number[]): {
  medianMs: number;
  minMs: number;
  maxMs: number;
  rangeMs: number;
} {
  const sorted = [...samples].sort((a, b) => a - b);
  const min = sorted[0] || 0;
  const max = sorted[sorted.length - 1] || 0;
  const median = sorted[Math.floor(sorted.length / 2)] || 0;
  const round = (value: number) => Math.round(value * 100) / 100;

  return {
    medianMs: round(median),
    minMs: round(min),
    maxMs: round(max),
    rangeMs: round(max - min),
  };
}

void main();
