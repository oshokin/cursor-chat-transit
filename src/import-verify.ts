import { assertOrderedReferences, parseRemappableJson } from './chat-json';
import * as db from './db';
import {
  decodeSqliteBytes,
  imageUuidsFromBubbles,
  requiredBlobKeys,
  resolveAttachmentPath,
  verifyAttachmentFile,
} from './dependencies';
import { prepareImport } from './import-prepare';
import { planFilenamesFromChat, readPlanFile, verifyPlanFile } from './plans';
import { connOf, inspectPair } from './transfer-context';
import type {
  BubbleRecord,
  ExportObject,
  ExportResources,
  SqliteConn,
  TransferContext,
  WorkspaceEntry,
} from './types';
import { TransferError } from './types';

/** Read back known chat records and resources before a receipt becomes durable. */
export async function verifyImport(opts: {
  /** Transfer context, including cancellation and phase reporting. */
  ctx: TransferContext;
  /** Destination workspace whose written rows are verified. */
  workspace: WorkspaceEntry;
  /** Open connections and detected layouts for both databases. */
  pair: Awaited<ReturnType<typeof inspectPair>>;
  /** Cloned chats, required records, and backup paths from prepare. */
  prepared: Awaited<ReturnType<typeof prepareImport>>;
}): Promise<string[]> {
  const { ctx, workspace } = opts;
  const { connWs, connGl, wsInfo, glInfo } = opts.pair;
  const {
    cloned,
    requiredComposers,
    requiredBubbles,
    plansDir,
    glBackup,
    wsBackup,
  } = opts.prepared;
  ctx.onPhase?.('verify', { chats: cloned.allComposers.length });
  const verifyConn = connOf(ctx, workspace.globalDbPath, true);
  const verifyIds = cloned.allComposers.map((c) => c.composerId);
  try {
    const present = await verifyBodies(verifyConn, cloned, verifyIds);
    await verifyBlobs(verifyConn, requiredComposers, cloned.resources);
    await verifyImages(workspace, requiredBubbles, cloned.resources);
    await verifyPlans(
      plansDir,
      requiredComposers,
      requiredBubbles,
      cloned.resources,
    );
    if (present.length !== verifyIds.length) {
      const err = new TransferError(
        'Import verification failed: not all composer bodies are present.',
      );
      err.backups = { global: glBackup, workspace: wsBackup };
      err.code = 'PARTIAL';
      throw err;
    }
    const resolved = await db.resolveComposers(connWs, connGl, {
      storageId: workspace.storageId,
      identity: workspace.identity,
      layoutWs: wsInfo.layout,
      layoutGl: glInfo.layout,
    });
    const resolvedIds = new Set(resolved.map((h) => h.composerId));
    if (verifyIds.some((id) => !resolvedIds.has(id))) {
      const err = new TransferError(
        'Import verification failed: resolver did not find the imported chat(s).',
      );
      err.backups = { global: glBackup, workspace: wsBackup };
      err.code = 'PARTIAL';
      throw err;
    }
  } catch (err) {
    if (err instanceof TransferError) {
      err.backups = err.backups || { global: glBackup, workspace: wsBackup };
      if (!err.code) err.code = 'PARTIAL';
      throw err;
    }
    const wrapped = new TransferError(
      err instanceof Error ? err.message : String(err),
    );
    wrapped.backups = { global: glBackup, workspace: wsBackup };
    wrapped.code = 'PARTIAL';
    throw wrapped;
  }

  return verifyIds;
}

/** Confirm composer bodies and ordered bubble references after commit. */
async function verifyBodies(
  verifyConn: SqliteConn,
  cloned: ExportObject,
  verifyIds: string[],
): Promise<string[]> {
  const present: string[] = [];
  for (const id of verifyIds) {
    const bodyRaw = await db.readKvText(verifyConn, `composerData:${id}`);
    if (bodyRaw === null || bodyRaw === undefined) continue;
    const body = parseRemappableJson(bodyRaw, `stored composer ${id}`);
    const available = await db.listBubbleIds(verifyConn, id);
    assertOrderedReferences(body, available);
    const expected = cloned.bubbles?.[id]?.length ?? 0;
    if (available.size < expected) {
      throw new TransferError(
        'Import verification failed: not all message records are present.',
      );
    }
    present.push(id);
  }

  return present;
}

/** Confirm required agentKv blobs match the export envelope. */
async function verifyBlobs(
  verifyConn: SqliteConn,
  requiredComposers: Record<string, string>,
  resources: ExportResources | undefined,
): Promise<void> {
  const required = requiredBlobKeys(requiredComposers);
  if (required.status !== 'ok' && Object.keys(requiredComposers).length) {
    throw new TransferError(
      'Import verification failed: conversation state is unsupported.',
    );
  }
  const expectedResources = new Map(
    (resources?.kv || []).map((row) => [row.key, row.value]),
  );
  for (const key of required.keys) {
    const stored = await db.readKvBytes(verifyConn, key);
    const expected = expectedResources.get(key);
    if (
      !stored ||
      (expected &&
        (stored.storageClass !== expected.storageClass ||
          !stored.bytes.equals(decodeSqliteBytes(expected))))
    ) {
      throw new TransferError(
        'Import verification failed: a required chat resource is missing or changed.',
      );
    }
  }
}

/** Confirm attached images exist on disk and match exported bytes when present. */
async function verifyImages(
  workspace: WorkspaceEntry,
  requiredBubbles: Record<string, BubbleRecord[]>,
  resources: ExportResources | undefined,
): Promise<void> {
  const neededImages = new Set<string>();
  for (const list of Object.values(requiredBubbles)) {
    for (const uuid of imageUuidsFromBubbles(list)) neededImages.add(uuid);
  }
  const byId = new Map(
    (resources?.attachments || []).map((row) => [row.id.toLowerCase(), row]),
  );
  for (const uuid of neededImages) {
    const exported = byId.get(uuid.toLowerCase());
    if (exported) {
      await verifyAttachmentFile(workspace, exported);
      continue;
    }
    const found = await resolveAttachmentPath(workspace, uuid);
    if (!found) {
      throw new TransferError(
        'Import verification failed: an attached image is missing.',
      );
    }
  }
}

/** Confirm plan files in the allowlisted directory match the envelope. */
async function verifyPlans(
  plansDir: string,
  requiredComposers: Record<string, string>,
  requiredBubbles: Record<string, BubbleRecord[]>,
  resources: ExportResources | undefined,
): Promise<void> {
  const neededPlans = new Set<string>();
  for (const [id, body] of Object.entries(requiredComposers)) {
    for (const name of planFilenamesFromChat(body, requiredBubbles[id])) {
      neededPlans.add(name);
    }
  }
  const byPlan = new Map(
    (resources?.plans || []).map((row) => [row.filename, row]),
  );
  for (const name of neededPlans) {
    const exported = byPlan.get(name);
    if (exported) {
      await verifyPlanFile(plansDir, exported);
      continue;
    }
    if (!(await readPlanFile(plansDir, name))) {
      throw new TransferError(
        'Import verification failed: a Cursor plan file is missing.',
      );
    }
  }
}
