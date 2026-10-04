import {
  collectAttachmentVariants,
  imageBasenamesFromBubbles,
} from './attachments';
import { canvasFilenamesFromChat, readCanvasFile } from './canvases';
import { readBlobGraph } from './blob-graph';
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
  CanvasResource,
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
  onProgress?: (
    processed: number,
    /** Total items in this operation. */
    total: number,
  ) => void;
  /** Local plans directory used to copy referenced plan files. */
  plansDir?: string;
  /** Canvas directory for this workspace. Null when the project slug is unknown. */
  canvasesDir?: string | null;
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
    resources: { kv: [], attachments: [], plans: [], canvases: [] },
    assessment: {
      status: 'unsupported',
      missingKeys: [],
      missingAttachments: [],
      missingPlans: [],
      missingCanvases: [],
    },
  });

  const required = requiredBlobKeys(opts.composers);

  if (required.status === 'unsupported') return empty();
  let total = 0;
  const kv: KvResource[] = [];
  const missingKeys: string[] = [];
  const seenKv = new Set<string>();
  const cache = new Map<string, Awaited<ReturnType<typeof db.readKvBytes>>>();

  for (const body of Object.values(opts.composers)) {
    /** Conversation state. */
    const parsed = JSON.parse(body) as {
      conversationState?: unknown;
    };

    const closed = await readBlobGraph(
      parsed.conversationState,
      async (/** Blob digests for this call. */ digests) => {
        const rows = await db.readKvBlobs(
          opts.conn,
          digests.map((/** Blob digest. */ digest) => `agentKv:blob:${digest}`),
        );

        const batch = new Map<string, Buffer | null>();

        for (const digest of digests) {
          const row = rows.get(`agentKv:blob:${digest}`) ?? null;

          cache.set(digest, row);
          batch.set(digest, row?.bytes ?? null);
        }

        return batch;
      },
    );

    if (closed.status !== 'ok') return empty();

    for (const key of closed.keys) {
      if (seenKv.has(key)) continue;
      seenKv.add(key);
      const row = cache.get(key.slice('agentKv:blob:'.length));

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

    for (const key of closed.missing) {
      if (!seenKv.has(key) && !missingKeys.includes(key)) missingKeys.push(key);
    }
  }

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

  const canvasNames: string[] = [];
  const seenCanvas = new Set<string>();

  for (const [id, body] of Object.entries(opts.composers)) {
    for (const name of canvasFilenamesFromChat(body, opts.bubbles[id])) {
      if (seenCanvas.has(name)) continue;
      seenCanvas.add(name);
      canvasNames.push(name);
    }
  }

  const units =
    kv.length +
    missingKeys.length +
    imageUuids.length +
    planNames.length +
    canvasNames.length;

  let done = 0;

  /** Report one collected kv, image, or plan unit toward export progress. */
  const tick = () => {
    if (!units) return;
    done += 1;
    opts.onProgress?.(done, units);
  };

  for (let i = 0; i < kv.length + missingKeys.length; i++) {
    opts.signal?.throwIfAborted();
    tick();
  }

  const attachments: AttachmentResource[] = [];
  const missingAttachments: string[] = [];

  for (const uuid of imageUuids) {
    opts.signal?.throwIfAborted();
    const referenced: string[] = [];
    const seenName = new Set<string>();

    for (const list of Object.values(opts.bubbles)) {
      for (const name of imageBasenamesFromBubbles(list, uuid)) {
        if (seenName.has(name)) continue;
        seenName.add(name);
        referenced.push(name);
      }
    }

    const found = await collectAttachmentVariants(
      opts.workspace,
      uuid,
      referenced,
    );

    tick();

    if (found.missing) missingAttachments.push(uuid);

    for (const resource of found.resources) {
      total += resource.byteLength;

      if (
        attachments.length + 1 > MAX_RESOURCE_COUNT ||
        total > MAX_TOTAL_RESOURCE_BYTES
      ) {
        fail('INVALID_RESOURCE', 'Resource set exceeds size limit.');
      }

      attachments.push(resource);
    }
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

  const canvases: CanvasResource[] = [];
  const missingCanvases: string[] = [];
  const canvasesDir = opts.canvasesDir ?? null;

  for (const filename of canvasNames) {
    opts.signal?.throwIfAborted();

    const resource = canvasesDir
      ? await readCanvasFile(canvasesDir, filename)
      : null;

    tick();

    if (!resource) {
      missingCanvases.push(filename);
      continue;
    }

    total += resource.byteLength;

    if (
      kv.length + attachments.length + plans.length + canvases.length + 1 >
        MAX_RESOURCE_COUNT ||
      total > MAX_TOTAL_RESOURCE_BYTES
    ) {
      fail('INVALID_RESOURCE', 'Resource set exceeds size limit.');
    }

    canvases.push(resource);
  }

  const status: DependencyAssessment['status'] =
    missingKeys.length ||
    missingAttachments.length ||
    missingPlans.length ||
    missingCanvases.length
      ? 'incomplete'
      : 'complete';

  return {
    resources: { kv, attachments, plans, canvases },
    assessment: {
      status,
      missingKeys,
      missingAttachments,
      missingPlans,
      missingCanvases,
    },
  };
}
