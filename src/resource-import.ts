import fs from 'node:fs';
import { decodeAttachment, resolveAttachmentPath } from './attachments';
import { imageUuidsFromBubbles, requiredBlobKeys } from './chat-dependencies';
import * as db from './db';
import {
  decodePlan,
  defaultPlansDirectory,
  planFilenamesFromChat,
  readPlanFile,
} from './plans';
import { resourceError as fail } from './resource-bytes';
import { decodeSqliteBytes } from './resource-codec';
import type {
  AttachmentResource,
  BubbleRecord,
  DependencyAssessment,
  ExportResources,
  KvResource,
  PlanResource,
  SqliteConn,
  WorkspaceEntry,
} from './types';

/**
 * Decide which resources to insert. Missing required data is incomplete;
 * identical target rows are reused and not rewritten.
 */
export async function planImportResources(opts: {
  /** Open destination global database. */
  conn: SqliteConn;
  /** Cloned composer bodies keyed by destination composer id. */
  composers: Record<string, string>;
  /** Cloned bubble groups keyed by destination composer id. */
  bubbles: Record<string, BubbleRecord[]>;
  /** Envelope resources from the export. */
  exported: ExportResources;
  /** Destination workspace used to resolve attachment files. */
  workspace: WorkspaceEntry;
  /** Cancellation for this plan. */
  signal?: AbortSignal;
  /** Complete chats whose missing resources must fail closed. */
  requiredComposers?: Record<string, string>;
  /** Complete-chat bubbles whose missing resources must fail closed. */
  requiredBubbles?: Record<string, BubbleRecord[]>;
  /** Local plans directory used to install referenced plan files. */
  plansDir?: string;
}): Promise<{
  /** Kv rows that must be inserted; identical existing rows are omitted. */
  toWrite: KvResource[];
  /** Attachment files that must be installed. */
  attachments: AttachmentResource[];
  /** Plan files that must be installed. */
  plans: PlanResource[];
  /** Completeness of the planned write. */
  assessment: DependencyAssessment;
}> {
  const allRefs = requiredBlobKeys(opts.composers);
  const required = requiredBlobKeys(opts.requiredComposers ?? opts.composers);
  if (required.status === 'unsupported' || allRefs.status === 'unsupported') {
    return {
      toWrite: [],
      attachments: [],
      plans: [],
      assessment: {
        status: 'unsupported',
        missingKeys: [],
        missingAttachments: [],
        missingPlans: [],
      },
    };
  }
  const requiredKeySet = new Set(required.keys);
  const byKey = new Map(opts.exported.kv.map((row) => [row.key, row]));
  const toWrite: KvResource[] = [];
  const missingKeys: string[] = [];
  for (const key of allRefs.keys) {
    opts.signal?.throwIfAborted();
    const exported = byKey.get(key);
    const existing = await db.readKvBytes(opts.conn, key);
    if (exported) {
      const bytes = decodeSqliteBytes(exported.value);
      if (existing) {
        if (
          existing.storageClass !== exported.value.storageClass ||
          !existing.bytes.equals(bytes)
        ) {
          fail(
            'RESOURCE_CONFLICT',
            'A required chat resource already exists with different data.',
          );
        }
        continue;
      }
      toWrite.push(exported);
      continue;
    }
    if (existing) continue;
    if (requiredKeySet.has(key)) missingKeys.push(key);
  }
  const requiredImages = new Set<string>();
  for (const list of Object.values(opts.requiredBubbles ?? opts.bubbles)) {
    for (const uuid of imageUuidsFromBubbles(list)) {
      requiredImages.add(uuid.toLowerCase());
    }
  }
  const byId = new Map(
    opts.exported.attachments.map((row) => [row.id.toLowerCase(), row]),
  );
  const attachments: AttachmentResource[] = [];
  const missingAttachments: string[] = [];
  const seen = new Set<string>();
  for (const list of Object.values(opts.bubbles)) {
    for (const uuid of imageUuidsFromBubbles(list)) {
      const id = uuid.toLowerCase();
      if (seen.has(id)) continue;
      seen.add(id);
      opts.signal?.throwIfAborted();
      const exported = byId.get(id);
      const found = await resolveAttachmentPath(opts.workspace, uuid);
      if (exported) {
        const bytes = decodeAttachment(exported);
        if (found) {
          const current = await fs.promises.readFile(found.filePath);
          if (!current.equals(bytes)) {
            fail(
              'RESOURCE_CONFLICT',
              'An attached image already exists with different data.',
            );
          }
          continue;
        }
        attachments.push(exported);
        continue;
      }
      if (found) continue;
      if (requiredImages.has(id)) missingAttachments.push(uuid);
    }
  }
  const requiredPlans = new Set<string>();
  for (const [id, body] of Object.entries(
    opts.requiredComposers ?? opts.composers,
  )) {
    for (const name of planFilenamesFromChat(
      body,
      (opts.requiredBubbles ?? opts.bubbles)[id],
    )) {
      requiredPlans.add(name);
    }
  }
  const allPlans: string[] = [];
  const seenPlan = new Set<string>();
  for (const [id, body] of Object.entries(opts.composers)) {
    for (const name of planFilenamesFromChat(body, opts.bubbles[id])) {
      if (seenPlan.has(name)) continue;
      seenPlan.add(name);
      allPlans.push(name);
    }
  }
  const byPlan = new Map(
    (opts.exported.plans || []).map((row) => [row.filename, row]),
  );
  const plans: PlanResource[] = [];
  const missingPlans: string[] = [];
  const plansDir = opts.plansDir || defaultPlansDirectory();
  for (const filename of allPlans) {
    opts.signal?.throwIfAborted();
    const exported = byPlan.get(filename);
    const found = await readPlanFile(plansDir, filename);
    if (exported) {
      const bytes = decodePlan(exported);
      if (found) {
        if (!decodePlan(found).equals(bytes)) {
          fail(
            'RESOURCE_CONFLICT',
            'A Cursor plan file already exists with different data.',
          );
        }
        continue;
      }
      plans.push(exported);
      continue;
    }
    if (found) continue;
    if (requiredPlans.has(filename)) missingPlans.push(filename);
  }
  const status: DependencyAssessment['status'] =
    missingKeys.length || missingAttachments.length || missingPlans.length
      ? 'incomplete'
      : 'complete';
  return {
    toWrite,
    attachments,
    plans,
    assessment: { status, missingKeys, missingAttachments, missingPlans },
  };
}
