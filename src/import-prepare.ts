import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  attachmentDirectory,
  attachmentFilename,
  rewriteChatImagePaths,
} from './attachments';
import {
  canvasFilePath,
  canvasFilenamesFromChat,
  readCanvasFile,
  rewriteChatCanvasUris,
} from './canvases';
import { cloneExportObjectForCopy } from './chat-copy';
import { missingDependencyMessage, planImportResources } from './dependencies';
import { pendingChatsFromClone } from './import-reconcile';
import { selectImportChats } from './import-selection';
import { type PendingImport } from './journal';
import {
  planFilePath,
  planFilenamesFromChat,
  readPlanFile,
  rewriteChatPlanUris,
} from './plans';
import { filterExportForPlan } from './recovery';
import { canvasesDirOf, plansDirOf } from './transfer-context';
import type {
  BubbleRecord,
  ExportObject,
  ExportResources,
  TransferContext,
  WorkspaceEntry,
} from './types';
import { TransferError } from './types';

/** Clone selected chats and validate resources before writing. */
export async function prepareImport(opts: {
  /** Transfer context, including cancellation and phase reporting. */
  ctx: TransferContext;
  /** Destination workspace whose databases will be written. */
  workspace: WorkspaceEntry;
  /** Validated export object being imported. */
  exportObj: ExportObject;
  /** Envelope resources already parsed from the export. */
  resources: ExportResources;
  /** Open global database connection used to plan resource writes. */
  connGl: Parameters<typeof planImportResources>[0]['conn'];
  /** Chats selected for a new copy, with snapshot hashes and quality. */
  selection: Awaited<ReturnType<typeof selectImportChats>>;
}) {
  const { ctx, workspace, exportObj, resources, connGl } = opts;
  const { recovery, toCreate, quality, snapshotBySource } = opts.selection;

  const filtered = filterExportForPlan(
    exportObj,
    {
      complete: recovery.complete.filter((id) => toCreate.includes(id)),
      historyOnly: recovery.historyOnly.filter((id) => toCreate.includes(id)),
      skipped: recovery.skipped,
    },
    resources,
  );

  ctx.onPhase?.('prepare');

  const { cloned, composerMap, bubbleMap } = await cloneExportObjectForCopy(
    filtered,
    { signal: ctx.signal },
  );

  ctx.onPhase?.('prepare', {
    chats: cloned.allComposers.length,
    bubbles: Object.values(cloned.bubbles || {}).reduce(
      (n, list) => n + (list?.length || 0),
      0,
    ),
  });

  const historyOnlyNew = new Set(
    recovery.historyOnly
      .map((id) => composerMap.get(id))
      .filter((id): id is string => Boolean(id)),
  );

  const requiredComposers: Record<string, string> = {};
  const requiredBubbles: Record<string, BubbleRecord[]> = {};

  for (const [id, body] of Object.entries(cloned.composers)) {
    if (historyOnlyNew.has(id)) continue;
    requiredComposers[id] = body;
    requiredBubbles[id] = cloned.bubbles?.[id] || [];
  }

  const plansDir = plansDirOf(ctx);
  const canvasesDir = canvasesDirOf(ctx, workspace);

  const plan = await planImportResources({
    conn: connGl,
    composers: cloned.composers,
    bubbles: cloned.bubbles || {},
    exported: cloned.resources || { kv: [], attachments: [], plans: [] },
    workspace,
    signal: ctx.signal,
    requiredComposers,
    requiredBubbles,
    plansDir,
    canvasesDir,
  });

  if (plan.assessment.status === 'unsupported') {
    const err = new TransferError(
      'This chat uses an unsupported conversation state format.',
    );

    err.code = 'UNSUPPORTED_STATE';

    throw err;
  }

  if (plan.assessment.status !== 'complete') {
    const err = new TransferError(missingDependencyMessage(plan.assessment));

    err.code = 'MISSING_DEPENDENCY';

    err.missing = [
      ...plan.assessment.missingKeys,
      ...plan.assessment.missingAttachments,
      ...plan.assessment.missingPlans,
      ...plan.assessment.missingCanvases,
    ];

    throw err;
  }

  const destByFilename = new Map<string, string>();

  const suppliedPlans = new Set(
    plan.plans.map((resource) => resource.filename),
  );

  for (const [id, body] of Object.entries(cloned.composers)) {
    for (const name of planFilenamesFromChat(body, cloned.bubbles?.[id])) {
      if (destByFilename.has(name)) continue;

      if (suppliedPlans.has(name) || (await readPlanFile(plansDir, name))) {
        destByFilename.set(name, planFilePath(plansDir, name));
      }
    }
  }

  rewriteChatPlanUris(cloned.composers, cloned.bubbles || {}, destByFilename);

  const destCanvasByFilename = new Map<string, string>();

  if (canvasesDir) {
    const suppliedCanvases = new Set(
      plan.canvases.map((resource) => resource.filename),
    );

    for (const [id, body] of Object.entries(cloned.composers)) {
      for (const name of canvasFilenamesFromChat(body, cloned.bubbles?.[id])) {
        if (destCanvasByFilename.has(name)) continue;

        if (
          suppliedCanvases.has(name) ||
          (await readCanvasFile(canvasesDir, name))
        ) {
          destCanvasByFilename.set(name, canvasFilePath(canvasesDir, name));
        }
      }
    }
  }

  rewriteChatCanvasUris(
    cloned.composers,
    cloned.bubbles || {},
    destCanvasByFilename,
  );

  const destImageByBasename = new Map<string, string>();
  const imagesDir = attachmentDirectory(workspace);

  for (const resource of cloned.resources?.attachments || []) {
    const dest = path.join(imagesDir, attachmentFilename(resource));

    destImageByBasename.set(attachmentFilename(resource), dest);

    for (const alias of resource.aliases || []) {
      destImageByBasename.set(alias, dest);
    }
  }

  rewriteChatImagePaths(
    cloned.composers,
    cloned.bubbles || {},
    destImageByBasename,
  );

  const pending: PendingImport = {
    operationId: randomUUID(),
    phase: 'prepared',
    chats: pendingChatsFromClone({
      cloned,
      composerMap,
      bubbleMap,
      snapshotBySource,
      quality,
    }),
  };

  return {
    cloned,
    historyOnlyNew,
    requiredComposers,
    requiredBubbles,
    plansDir,
    canvasesDir,
    plan,
    pending,
  };
}
