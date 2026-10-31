import { randomUUID } from 'node:crypto';
import { familyImportAdjustments } from './chat-family';
import type { Plan } from './import-bundle-common';
import type { ComposerHeader } from './types';

/** One catalog row that already has an import decision. */
export interface CatalogFamilyRow {
  /** Source composer id. */
  sourceId: string;
  /** Catalog ordinal. */
  ordinal: number;
  /** Display name when the archive has one. */
  name?: string;
  /** create copies this snapshot. skip leaves the existing copy. */
  decision: 'create' | 'skip';
  /** Destination id chosen before family adjustment. */
  targetId: string;
  /** Snapshot hash. */
  hash: string;
  /** Header fields that name the family. */
  header: ComposerHeader;
}

/** One work-index update, in the same order as the previous per-row statements. */
export interface FamilyPlanUpdate {
  /** Source composer id. */
  sourceId: string;
  /** Decision written back to the work index. */
  decision: 'skip' | 'create';
  /** Why the family adjustment changed the row. */
  reason: 'missing-family' | 'family-copy';
  /** New destination id. Present only for a real promote. */
  targetId?: string;
}

/**
 * Apply drop and promote once.
 * Row lookup, removal, and the skipped-family set are indexed.
 * A new id is allocated only for a row that is actually promoted.
 * Plan order matches the previous per-row filters.
 */
export function adjustFamilyPlan(
  /** Catalog rows that received a create or skip decision. */
  rows: readonly CatalogFamilyRow[],
  /** Plan arrays mutated in place. */
  plan: Plan,
  /** Id source. Production uses a random UUID. */
  allocateId: () => string = randomUUID,
): {
  /** Work-index updates in drop-then-promote order. */
  updates: FamilyPlanUpdate[];
  /** Skip rows that still belong to a reused family. */
  skippedFamilies: CatalogFamilyRow[];
} {
  const adjusted = familyImportAdjustments(rows);
  const byId = new Map(rows.map((row) => [row.sourceId, row]));
  const drop = new Set(adjusted.drop);
  const promote = new Set(adjusted.promote);
  const updates: FamilyPlanUpdate[] = [];
  const dropOrdinals = new Set<number>();

  for (const sourceId of adjusted.drop) {
    const row = byId.get(sourceId);

    if (!row) continue;
    updates.push({ sourceId, decision: 'skip', reason: 'missing-family' });
    dropOrdinals.add(row.ordinal);

    plan.skipped.push({
      composerId: sourceId,
      name: row.name,
      reason: 'The parent chat is not in this archive.',
    });
  }

  if (dropOrdinals.size) {
    plan.create = plan.create.filter((ordinal) => !dropOrdinals.has(ordinal));

    plan.repair = plan.repair.filter((item) => !dropOrdinals.has(item.ordinal));

    plan.newVersions = plan.newVersions.filter(
      (item) => !drop.has(item.composerId),
    );

    plan.restored = plan.restored.filter((item) => !drop.has(item.composerId));
  }

  const promoted = new Set<string>();

  for (const sourceId of adjusted.promote) {
    const row = byId.get(sourceId);

    if (!row) continue;
    const targetId = allocateId();

    updates.push({
      sourceId,
      decision: 'create',
      reason: 'family-copy',
      targetId,
    });

    promoted.add(sourceId);
    plan.create.push(row.ordinal);

    plan.newVersions.push({
      composerId: sourceId,
      name: row.name,
      reason: 'A subagent changed; a new conversation family will be created',
    });
  }

  if (promoted.size) {
    const promotedOrdinals = new Set(
      rows
        .filter((row) => promoted.has(row.sourceId))
        .map((row) => row.ordinal),
    );

    plan.already = plan.already.filter(
      (item) => !promoted.has(item.composerId),
    );

    plan.repair = plan.repair.filter(
      (item) => !promotedOrdinals.has(item.ordinal),
    );
  }

  return {
    updates,
    skippedFamilies: rows.filter(
      (row) =>
        row.decision === 'skip' &&
        !promote.has(row.sourceId) &&
        !drop.has(row.sourceId),
    ),
  };
}
