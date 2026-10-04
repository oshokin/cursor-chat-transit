import { canvasFilenamesFromChat, readCanvasFile } from './canvases';
import {
  blobKeysFromComposerBody,
  imageUuidsFromBubbles,
  resolveAttachmentPath,
} from './dependencies';
import * as db from './db';
import { planFilenamesFromChat, readPlanFile } from './plans';
import type {
  BubbleRecord,
  ExportObject,
  ExportResources,
  SkippedChatRef,
  SqliteConn,
  WorkspaceEntry,
} from './types';

/** Per-chat inspect result used to decide complete, history-only, or skip. */
export type ChatInspection =
  | {
      /** Every required body, bubble, and resource is present. */
      status: 'complete';
      /** Composer id in the export. */
      composerId: string;
    }
  | {
      /** The chat can be imported as history-only when partial recovery is on. */
      status: 'missing-dependencies';
      /** Composer id in the export. */
      composerId: string;
      /** Missing `agentKv:blob:*` values. */
      missingBlobs: number;
      missingImages: number;
      /** Missing plan files. */
      missingPlans: number;
      /** Missing canvas files. */
      missingCanvases: number;
    }
  | {
      /** The chat cannot be imported even with partial recovery. */
      status: 'unusable-chat';
      /** Composer id in the export. */
      composerId: string;
      /** Why this chat must be skipped. */
      reason: string;
    };

/** Partition of export chats when partial recovery is allowed. */
export interface RecoveryPlan {
  /** Composer ids that can be imported complete. */
  complete: string[];
  /** Composer ids that can be imported as history-only. */
  historyOnly: string[];
  /** Composer ids that must be skipped, with a reason. */
  skipped: SkippedChatRef[];
}

/** Never treats DB failures, conflicts, unsafe paths, or invalid envelopes as recoverable. */
export function planRecovery(
  chats: ChatInspection[],
  /** Keep readable history when optional resources are missing. */
  allowPartial: boolean,
): RecoveryPlan {
  const plan: RecoveryPlan = { complete: [], historyOnly: [], skipped: [] };

  if (!allowPartial && chats.some((chat) => chat.status !== 'complete')) {
    const err = new Error('INCOMPLETE_IMPORT');

    throw err;
  }

  for (const chat of chats) {
    if (chat.status === 'complete') plan.complete.push(chat.composerId);
    else if (chat.status === 'missing-dependencies')
      plan.historyOnly.push(chat.composerId);
    else
      plan.skipped.push({ composerId: chat.composerId, reason: chat.reason });
  }

  if (plan.complete.length + plan.historyOnly.length === 0) {
    throw new Error('NOTHING_TO_IMPORT');
  }

  return plan;
}

/** Inspect one composer against file resources and the target store. */
export async function inspectComposer(opts: {
  /** Composer id in the export. */
  composerId: string;
  /** Composer body JSON text, if present. */
  body: string | undefined;
  /** Bubble rows for this composer, if the export included any. */
  bubbles: BubbleRecord[] | undefined;
  /** Kv keys present in the export envelope. */
  resourceKeys: Set<string>;
  /** Attachment ids present in the export envelope. */
  attachmentIds: Set<string>;
  /** Plan basenames present in the export envelope. */
  planFiles: Set<string>;
  /** Canvas basenames present in the export envelope. */
  canvasFiles: Set<string>;
  /** Local plans directory used to confirm plan files. */
  plansDir?: string;
  /** Canvas directory used to confirm canvas files. */
  canvasesDir?: string | null;
  /** Open destination global database, used to reuse identical kv rows. */
  conn: SqliteConn;
  /** Destination workspace used to resolve attachment files. */
  workspace: WorkspaceEntry;
  /** Cancellation for this inspection. */
  signal?: AbortSignal;
}): Promise<ChatInspection> {
  const { composerId } = opts;

  if (typeof opts.body !== 'string' || !opts.body) {
    return {
      status: 'unusable-chat',
      composerId,
      reason: 'missing composer body',
    };
  }

  let body: Record<string, unknown>;

  try {
    const parsed: unknown = JSON.parse(opts.body);

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        status: 'unusable-chat',
        composerId,
        reason: 'unsupported payload',
      };
    }

    body = parsed as Record<string, unknown>;
  } catch {
    return {
      status: 'unusable-chat',
      composerId,
      reason: 'malformed composer body',
    };
  }

  const list = opts.bubbles;

  if (list !== undefined && !Array.isArray(list)) {
    return {
      status: 'unusable-chat',
      composerId,
      reason: 'malformed bubble list',
    };
  }

  const available = new Set<string>();

  for (const row of list || []) {
    if (
      !row ||
      typeof row !== 'object' ||
      typeof row.bubbleId !== 'string' ||
      !row.bubbleId ||
      row.key !== `bubbleId:${composerId}:${row.bubbleId}` ||
      available.has(row.bubbleId) ||
      typeof row.value !== 'string'
    ) {
      return {
        status: 'unusable-chat',
        composerId,
        reason: 'invalid bubble record',
      };
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(row.value);
    } catch {
      return {
        status: 'unusable-chat',
        composerId,
        reason: 'malformed bubble',
      };
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        status: 'unusable-chat',
        composerId,
        reason: 'unsupported bubble payload',
      };
    }

    const bubble = parsed as Record<string, unknown>;

    if (
      (bubble.bubbleId !== undefined && bubble.bubbleId !== row.bubbleId) ||
      (bubble.composerId !== undefined && bubble.composerId !== composerId)
    ) {
      return {
        status: 'unusable-chat',
        composerId,
        reason: 'bubble body ID mismatch',
      };
    }

    available.add(row.bubbleId);
  }

  const headers = body.fullConversationHeadersOnly;

  if (headers !== undefined) {
    if (!Array.isArray(headers)) {
      return {
        status: 'unusable-chat',
        composerId,
        reason: 'incomplete message records',
      };
    }

    for (const header of headers) {
      if (!header || typeof header !== 'object' || Array.isArray(header)) {
        return {
          status: 'unusable-chat',
          composerId,
          reason: 'incomplete message records',
        };
      }

      const bubbleId = (
        header as {
          bubbleId?: unknown;
        }
      ).bubbleId;

      if (typeof bubbleId !== 'string' || !available.has(bubbleId)) {
        return {
          status: 'unusable-chat',
          composerId,
          reason: 'incomplete message records',
        };
      }
    }
  }

  const blobs = blobKeysFromComposerBody(opts.body);

  if (blobs.status === 'unsupported') {
    return {
      status: 'unusable-chat',
      composerId,
      reason: 'unsupported conversation state',
    };
  }

  let images: string[];

  try {
    images = imageUuidsFromBubbles(list);
  } catch {
    return {
      status: 'unusable-chat',
      composerId,
      reason: 'invalid attachment id',
    };
  }

  let missingBlobs = 0;

  for (const key of blobs.keys) {
    opts.signal?.throwIfAborted();
    if (opts.resourceKeys.has(key)) continue;
    if (await db.kvExists(opts.conn, key)) continue;
    missingBlobs += 1;
  }

  let missingImages = 0;

  for (const uuid of images) {
    opts.signal?.throwIfAborted();
    if (opts.attachmentIds.has(uuid.toLowerCase())) continue;
    if (await resolveAttachmentPath(opts.workspace, uuid)) continue;
    missingImages += 1;
  }

  let missingPlans = 0;

  if (opts.plansDir) {
    for (const name of planFilenamesFromChat(opts.body, list)) {
      opts.signal?.throwIfAborted();
      if (opts.planFiles.has(name)) continue;
      if (await readPlanFile(opts.plansDir, name)) continue;
      missingPlans += 1;
    }
  } else {
    for (const name of planFilenamesFromChat(opts.body, list)) {
      if (opts.planFiles.has(name)) continue;
      missingPlans += 1;
    }
  }

  let missingCanvases = 0;

  if (opts.canvasesDir) {
    for (const name of canvasFilenamesFromChat(opts.body, list)) {
      opts.signal?.throwIfAborted();
      if (opts.canvasFiles.has(name)) continue;
      if (await readCanvasFile(opts.canvasesDir, name)) continue;
      missingCanvases += 1;
    }
  } else {
    for (const name of canvasFilenamesFromChat(opts.body, list)) {
      if (opts.canvasFiles.has(name)) continue;
      missingCanvases += 1;
    }
  }

  if (missingBlobs || missingImages || missingPlans || missingCanvases) {
    return {
      status: 'missing-dependencies',
      composerId,
      missingBlobs,
      missingImages,
      missingPlans,
      missingCanvases,
    };
  }

  return { status: 'complete', composerId };
}

/** Inspect every listed chat independently. Duplicate ids are a file error, not recovery. */
export async function inspectExportChats(opts: {
  /** Validated export object being inspected. */
  exportObj: ExportObject;
  /** Envelope resources already parsed from the export. */
  resources: ExportResources;
  /** Open destination global database, used to reuse identical kv rows. */
  conn: SqliteConn;
  /** Destination workspace used to resolve attachment files. */
  workspace: WorkspaceEntry;
  /** Cancellation for this inspection. */
  signal?: AbortSignal;
  /** Local plans directory used to confirm plan files. */
  plansDir?: string;
  /** Canvas directory used to confirm canvas files. */
  canvasesDir?: string | null;
  /** Coarse progress while chats are inspected. */
  onProgress?: (
    processed: number,
    /** Total items in this operation. */
    total: number,
  ) => void;
}): Promise<ChatInspection[]> {
  const resourceKeys = new Set(opts.resources.kv.map((row) => row.key));

  const attachmentIds = new Set(
    opts.resources.attachments.map((row) => row.id.toLowerCase()),
  );

  const planFiles = new Set(
    (opts.resources.plans || []).map((row) => row.filename),
  );

  const canvasFiles = new Set(
    (opts.resources.canvases || []).map((row) => row.filename),
  );

  const out: ChatInspection[] = [];
  const total = opts.exportObj.allComposers.length;
  let processed = 0;

  for (const header of opts.exportObj.allComposers) {
    const id = header.composerId;

    out.push(
      await inspectComposer({
        composerId: id,
        body: opts.exportObj.composers[id],
        bubbles: opts.exportObj.bubbles?.[id],
        resourceKeys,
        attachmentIds,
        planFiles,
        canvasFiles,
        plansDir: opts.plansDir,
        canvasesDir: opts.canvasesDir,
        conn: opts.conn,
        workspace: opts.workspace,
        signal: opts.signal,
      }),
    );

    processed += 1;
    opts.onProgress?.(processed, total);
  }

  return out;
}

/** Keep only chats the recovery plan will write. */
export function filterExportForPlan(
  /** In-memory export being spilled. */
  exportObj: ExportObject,
  plan: RecoveryPlan,
  /** Resource rows for this chat. */
  resources: ExportResources,
): ExportObject {
  const keep = new Set([...plan.complete, ...plan.historyOnly]);

  const allComposers = exportObj.allComposers.filter((header) =>
    keep.has(header.composerId),
  );

  const composers: Record<string, string> = {};
  const bubbles: Record<string, BubbleRecord[]> = {};

  for (const id of keep) {
    const body = exportObj.composers[id];

    if (body !== undefined) composers[id] = body;
    const list = exportObj.bubbles?.[id];

    if (list) bubbles[id] = list;
  }

  return {
    ...exportObj,
    allComposers,
    composers,
    bubbles,
    resources,
  };
}
