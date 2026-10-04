import fs from 'node:fs';
import path from 'node:path';
import {
  attachmentDirectory,
  attachmentFilename,
  decodeAttachment,
  resolveAttachmentPath,
} from './attachments';
import {
  canvasFilenamesFromChat,
  decodeCanvas,
  readCanvasFile,
} from './canvases';
import { resolveBlobGraph } from './blob-graph';
import { imageUuidsFromBubbles, requiredBlobKeys } from './chat-dependencies';
import * as db from './db';
import {
  decodePlan,
  defaultPlansDirectory,
  planFilenamesFromChat,
  readPlanFile,
} from './plans';
import { classifyKvConflict, kvConflictDetail } from './kv-compare';
import { resourceError as fail, sha256Hex } from './resource-bytes';
import { pathInside } from './resource-files';
import { decodeSqliteBytes } from './resource-codec';
import { TransferError } from './types';
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
  /** Canvas directory used to install referenced canvas files. */
  canvasesDir?: string | null;
}): Promise<{
  /** Kv rows that must be inserted; identical existing rows are omitted. */
  toWrite: KvResource[];
  /** Attachment files that must be installed. */
  attachments: AttachmentResource[];
  /** Plan files that must be installed. */
  plans: PlanResource[];
  /** Canvas files that must be installed. */
  canvases: CanvasResource[];
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
      canvases: [],
      assessment: {
        status: 'unsupported',
        missingKeys: [],
        missingAttachments: [],
        missingPlans: [],
        missingCanvases: [],
      },
    };
  }

  const blobBytes = new Map<string, Buffer>();

  for (const row of opts.exported.kv) {
    if (!row.key.startsWith('agentKv:blob:')) continue;

    blobBytes.set(
      row.key.slice('agentKv:blob:'.length),
      decodeSqliteBytes(row.value),
    );
  }

  /** Blob keys reachable from the composer bodies. */
  const closureKeys = (
    /** Composer JSON keyed by composer id. */
    bodies: Record<string, string>,
  ): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();

    for (const body of Object.values(bodies)) {
      /** Conversation state. */
      const state = (
        JSON.parse(body) as {
          conversationState?: unknown;
        }
      ).conversationState;

      const closed = resolveBlobGraph(state, blobBytes);

      const ids =
        closed.status === 'ok' ? [...closed.keys, ...closed.missing] : [];

      for (const key of ids) {
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(key);
      }
    }

    return out;
  };

  const requiredKeySet = new Set(
    closureKeys(opts.requiredComposers ?? opts.composers),
  );

  const allKeys = closureKeys(opts.composers);

  const byKey = new Map(opts.exported.kv.map((row) => [row.key, row]));

  const toWrite: KvResource[] = [];
  const missingKeys: string[] = [];

  for (const key of allKeys) {
    opts.signal?.throwIfAborted();
    const exported = byKey.get(key);
    const existing = await db.readKvBytes(opts.conn, key);

    if (exported) {
      const bytes = decodeSqliteBytes(exported.value);

      if (existing) {
        const facts = classifyKvConflict(existing, {
          storageClass: exported.value.storageClass,
          sha256: sha256Hex(bytes),
          byteLength: bytes.length,
        });

        if (facts) {
          const err = new TransferError(
            'A required chat resource already exists with different data.',
          );

          err.code = 'RESOURCE_CONFLICT';
          err.detail = kvConflictDetail(facts, key, 'preflight');

          throw err;
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

  const byUuid = new Map<string, AttachmentResource[]>();

  for (const row of opts.exported.attachments) {
    const id = row.id.toLowerCase();
    const list = byUuid.get(id) || [];

    list.push(row);
    byUuid.set(id, list);
  }

  const attachments: AttachmentResource[] = [];
  const missingAttachments: string[] = [];
  const seen = new Set<string>();
  const imagesDir = attachmentDirectory(opts.workspace);

  for (const list of Object.values(opts.bubbles)) {
    for (const uuid of imageUuidsFromBubbles(list)) {
      const id = uuid.toLowerCase();

      if (seen.has(id)) continue;
      seen.add(id);
      opts.signal?.throwIfAborted();
      const exported = byUuid.get(id) || [];

      if (!exported.length) {
        const found = await resolveAttachmentPath(opts.workspace, uuid);

        if (found) continue;
        if (requiredImages.has(id)) missingAttachments.push(uuid);
        continue;
      }

      for (const row of exported) {
        const dest = path.join(imagesDir, attachmentFilename(row));
        const bytes = decodeAttachment(row);
        let current: Buffer | null = null;

        if (pathInside(imagesDir, dest)) {
          try {
            const lst = await fs.promises.lstat(dest);

            if (lst.isFile() && !lst.isSymbolicLink()) {
              current = await fs.promises.readFile(dest);
            }
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
          }
        }

        if (current) {
          if (!current.equals(bytes)) {
            fail(
              'RESOURCE_CONFLICT',
              'An attached image already exists with different data.',
            );
          }

          continue;
        }

        attachments.push(row);
      }
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

  const requiredCanvases = new Set<string>();

  for (const [id, body] of Object.entries(
    opts.requiredComposers ?? opts.composers,
  )) {
    for (const name of canvasFilenamesFromChat(
      body,
      (opts.requiredBubbles ?? opts.bubbles)[id],
    )) {
      requiredCanvases.add(name);
    }
  }

  const allCanvases: string[] = [];
  const seenCanvas = new Set<string>();

  for (const [id, body] of Object.entries(opts.composers)) {
    for (const name of canvasFilenamesFromChat(body, opts.bubbles[id])) {
      if (seenCanvas.has(name)) continue;
      seenCanvas.add(name);
      allCanvases.push(name);
    }
  }

  const byCanvas = new Map(
    (opts.exported.canvases || []).map((row) => [row.filename, row]),
  );

  const canvases: CanvasResource[] = [];
  const missingCanvases: string[] = [];
  const canvasesDir = opts.canvasesDir ?? null;

  for (const filename of allCanvases) {
    opts.signal?.throwIfAborted();
    const exported = byCanvas.get(filename);

    const found = canvasesDir
      ? await readCanvasFile(canvasesDir, filename)
      : null;

    if (exported) {
      if (!canvasesDir) {
        if (requiredCanvases.has(filename)) missingCanvases.push(filename);
        continue;
      }

      const bytes = decodeCanvas(exported);

      if (found) {
        if (!decodeCanvas(found).equals(bytes)) {
          fail(
            'RESOURCE_CONFLICT',
            'A Cursor canvas file already exists with different data.',
          );
        }

        continue;
      }

      canvases.push(exported);
      continue;
    }

    if (found) continue;
    if (requiredCanvases.has(filename)) missingCanvases.push(filename);
  }

  const status: DependencyAssessment['status'] =
    missingKeys.length ||
    missingAttachments.length ||
    missingPlans.length ||
    missingCanvases.length
      ? 'incomplete'
      : 'complete';

  return {
    toWrite,
    attachments,
    plans,
    canvases,
    assessment: {
      status,
      missingKeys,
      missingAttachments,
      missingPlans,
      missingCanvases,
    },
  };
}
