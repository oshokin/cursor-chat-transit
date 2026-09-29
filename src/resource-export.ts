import { readAttachmentFile, resolveAttachmentPath } from './attachments';
import { imageUuidsFromBubbles, requiredBlobKeys } from './chat-dependencies';
import * as db from './db';
import {
  defaultPlansDirectory,
  planFilenamesFromChat,
  readPlanFile,
} from './plans';
import { resourceError as fail } from './resource-bytes';
import {
  MAX_RESOURCE_COUNT,
  MAX_TOTAL_RESOURCE_BYTES,
  encodeSqliteBytes,
} from './resource-codec';
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

/** Collect reachable blobs and images from a consistent source snapshot. */
export async function collectExportResources(opts: {
  /** Open source global database. */
  conn: SqliteConn;
  /** Composer bodies keyed by composer id. */
  composers: Record<string, string>;
  /** Bubble groups keyed by composer id. */
  bubbles: Record<string, BubbleRecord[]>;
  /** Source workspace used to resolve attachment files. */
  workspace: WorkspaceEntry;
  /** Cancellation for this collection. */
  signal?: AbortSignal;
  /** Coarse progress while resources are read. */
  onProgress?: (processed: number, total: number) => void;
  /** Local plans directory used to copy referenced plan files. */
  plansDir?: string;
}): Promise<{
  /** Envelope resources collected from the source snapshot. */
  resources: ExportResources;
  /** Completeness of the collected resources. */
  assessment: DependencyAssessment;
}> {
  /** Empty assessment used when blob keys cannot be classified. */
  const empty = (): {
    /** Empty resource envelope. */
    resources: ExportResources;
    /** Unsupported-state assessment with no missing keys. */
    assessment: DependencyAssessment;
  } => ({
    resources: { kv: [], attachments: [], plans: [] },
    assessment: {
      status: 'unsupported',
      missingKeys: [],
      missingAttachments: [],
      missingPlans: [],
    },
  });
  const required = requiredBlobKeys(opts.composers);
  if (required.status === 'unsupported') return empty();
  const kv: KvResource[] = [];
  const missingKeys: string[] = [];
  let total = 0;
  const imageUuids: string[] = [];
  const seenImg = new Set<string>();
  for (const list of Object.values(opts.bubbles)) {
    for (const uuid of imageUuidsFromBubbles(list)) {
      const id = uuid.toLowerCase();
      if (seenImg.has(id)) continue;
      seenImg.add(id);
      imageUuids.push(uuid);
    }
  }
  const planNames: string[] = [];
  const seenPlan = new Set<string>();
  for (const [id, body] of Object.entries(opts.composers)) {
    for (const name of planFilenamesFromChat(body, opts.bubbles[id])) {
      if (seenPlan.has(name)) continue;
      seenPlan.add(name);
      planNames.push(name);
    }
  }
  const units = required.keys.length + imageUuids.length + planNames.length;
  let done = 0;
  /** Report one collected kv, image, or plan unit toward export progress. */
  const tick = () => {
    if (!units) return;
    done += 1;
    opts.onProgress?.(done, units);
  };
  for (const key of required.keys) {
    opts.signal?.throwIfAborted();
    const row = await db.readKvBytes(opts.conn, key);
    tick();
    if (!row) {
      missingKeys.push(key);
      continue;
    }
    total += row.bytes.length;
    if (
      kv.length + 1 > MAX_RESOURCE_COUNT ||
      total > MAX_TOTAL_RESOURCE_BYTES
    ) {
      fail('INVALID_RESOURCE', 'Resource set exceeds size limit.');
    }
    kv.push({
      key,
      value: encodeSqliteBytes(row.bytes, row.storageClass),
    });
  }
  const attachments: AttachmentResource[] = [];
  const missingAttachments: string[] = [];
  for (const uuid of imageUuids) {
    opts.signal?.throwIfAborted();
    const found = await resolveAttachmentPath(opts.workspace, uuid);
    tick();
    if (!found) {
      missingAttachments.push(uuid);
      continue;
    }
    const resource = await readAttachmentFile(
      found.filePath,
      uuid,
      found.extension,
    );
    total += resource.byteLength;
    if (
      attachments.length + 1 > MAX_RESOURCE_COUNT ||
      total > MAX_TOTAL_RESOURCE_BYTES
    ) {
      fail('INVALID_RESOURCE', 'Resource set exceeds size limit.');
    }
    attachments.push(resource);
  }
  const plans: PlanResource[] = [];
  const missingPlans: string[] = [];
  const plansDir = opts.plansDir || defaultPlansDirectory();
  for (const filename of planNames) {
    opts.signal?.throwIfAborted();
    const resource = await readPlanFile(plansDir, filename);
    tick();
    if (!resource) {
      missingPlans.push(filename);
      continue;
    }
    total += resource.byteLength;
    if (
      kv.length + attachments.length + plans.length + 1 > MAX_RESOURCE_COUNT ||
      total > MAX_TOTAL_RESOURCE_BYTES
    ) {
      fail('INVALID_RESOURCE', 'Resource set exceeds size limit.');
    }
    plans.push(resource);
  }
  const status: DependencyAssessment['status'] =
    missingKeys.length || missingAttachments.length || missingPlans.length
      ? 'incomplete'
      : 'complete';
  return {
    resources: { kv, attachments, plans },
    assessment: { status, missingKeys, missingAttachments, missingPlans },
  };
}
