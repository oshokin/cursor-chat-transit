import { WorkspaceHeaderReader } from './workspace-header-reader';
import { transferEvent } from './transfer-events';
import type { ComposerHeader, TransferContext, WorkspaceEntry } from './types';

/** On-demand search reads headers only, never whole conversations. */
export type CatalogueJob = Pick<
  TransferContext,
  'executable' | 'initFile' | 'timeoutMs' | 'busyTimeoutMs'
> & {
  /** Worker task discriminator. */
  kind: 'workspace-catalogue';
  /** Physical storage entries in the UI's established sort order. */
  workspaces: WorkspaceEntry[];
};

/** One incremental catalogue result. Errors must not masquerade as empty workspaces. */
export interface CatalogueUpdate {
  /** Index in the job's workspace list; no duplicated workspace metadata over IPC. */
  index: number;
  /** Headers from supported indexes, with presentation timestamps. */
  headers?: ComposerHeader[];
  /** Read failure for this workspace only. */
  error?: string;
}

/** Read each workspace once and share global header enumeration for the whole search. */
export async function runCatalogue(
  /** Worker job naming the databases and workspace list. */
  job: CatalogueJob,
  /** Cancellation for the catalogue read. */
  signal: AbortSignal,
  /** Called with each workspace result. */
  update: (row: CatalogueUpdate) => void,
): Promise<{
  /** Workspaces whose headers could not be read. */
  failed: number;
}> {
  const reader = new WorkspaceHeaderReader({ ...job, signal }, true);
  let failed = 0;

  for (const [index, workspace] of job.workspaces.entries()) {
    signal.throwIfAborted();

    try {
      const headers = await reader.read(workspace);

      signal.throwIfAborted();
      update({ index, headers });
    } catch (error) {
      signal.throwIfAborted();
      failed++;

      update({
        index,
        error:
          error instanceof Error
            ? error.message
            : 'Unable to read chat headers',
      });

      transferEvent({
        action: 'Search workspace unavailable',
        status: 'failed',
        path: workspace.workspaceDbPath,
        errorCode: 'READ_FAILED',
      });
    }
  }

  return { failed };
}
