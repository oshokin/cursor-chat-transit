import type {
  ExportChatIssue,
  ImportResult,
  TransferPhase,
  TransferPhaseMetrics,
  WorkspaceEntry,
} from './types';
import { chatListLabel } from './picker';

/** Selected workspace still present, never chosen, or gone from disk. */
export type WorkspaceResolve =
  | {
      /** The remembered storage pair is still on disk. */
      status: 'ok';
      /** Workspace entry to use for the transfer. */
      workspace: WorkspaceEntry;
    }
  | {
      /** No workspace has been chosen yet. */
      status: 'none';
    }
  | {
      /** The remembered pair is no longer among the discovered entries. */
      status: 'missing';
    };

/** Reuse the selected storage pair; never substitute a different project. */
export function resolveSelectedWorkspace(
  selected: WorkspaceEntry | undefined,
  entries: WorkspaceEntry[],
): WorkspaceResolve {
  if (!selected) return { status: 'none' };
  const found = entries.find(
    (entry) =>
      entry.storageId === selected.storageId &&
      entry.storageRoot === selected.storageRoot,
  );
  return found ? { status: 'ok', workspace: found } : { status: 'missing' };
}

/** Which determinate progress map to use. */
export type TransferKind = 'export' | 'import';

/** Export phase spans as percent of the 0–100 bar. */
const EXPORT_SPAN: Record<string, readonly [number, number]> = {
  selection: [6, 14],
  read: [14, 42],
  collect: [42, 72],
  write: [72, 100],
};

/** Import phase spans as percent of the 0–100 bar. */
const IMPORT_SPAN: Record<string, readonly [number, number]> = {
  read: [6, 14],
  validate: [14, 22],
  collect: [22, 38],
  prepare: [38, 55],
  backup: [55, 65],
  write: [65, 78],
  'global-commit': [78, 86],
  'workspace-commit': [86, 93],
  verify: [93, 100],
};

/** 0–100 for the sidebar bar and Notification increment. */
export function phaseProgress(
  kind: TransferKind,
  phase: TransferPhase,
  metrics: TransferPhaseMetrics = {},
): number {
  const span = (kind === 'export' ? EXPORT_SPAN : IMPORT_SPAN)[phase];
  if (!span) return 0;
  const [start, end] = span;
  const { processed, total } = metrics;
  if (typeof processed === 'number' && typeof total === 'number' && total > 0) {
    const t = Math.min(1, Math.max(0, processed / total));
    return Math.round(start + (end - start) * t);
  }
  return start;
}

/** Short English reason for one incomplete export chat. */
function issueReason(issue: ExportChatIssue): string {
  if (issue.reason === 'missing-body') return 'has no stored body';
  if (issue.reason === 'unsupported-state') {
    return 'has an unsupported conversation state';
  }
  if (issue.reason === 'invalid-attachment-id') {
    return 'has an invalid attachment id';
  }
  const parts: string[] = [];
  if (issue.missingBlobs) {
    parts.push(
      `${issue.missingBlobs} blob${issue.missingBlobs === 1 ? '' : 's'}`,
    );
  }
  if (issue.missingImages) {
    parts.push(
      `${issue.missingImages} image${issue.missingImages === 1 ? '' : 's'}`,
    );
  }
  if (issue.missingPlans) {
    parts.push(
      `${issue.missingPlans} plan${issue.missingPlans === 1 ? '' : 's'}`,
    );
  }
  return parts.length
    ? `is missing ${parts.join(' and ')}`
    : 'is missing required chat data';
}

/** Popup and sidebar copy. Many chats are listed by name, then truncated. */
export function formatIncompleteExportNotice(
  issues: ExportChatIssue[],
  maxNames = 3,
): { toast: string; detail: string } {
  if (!issues.length) {
    return {
      toast:
        'Export is incomplete. Open the operation log to see which chats are affected.',
      detail: 'One or more chats are incomplete.',
    };
  }
  /** Quote a chat title for the incomplete-export toast. */
  const title = (issue: ExportChatIssue) =>
    JSON.stringify(chatListLabel(issue.name));
  if (issues.length === 1) {
    const issue = issues[0]!;
    const clause = issueReason(issue);
    return {
      toast: `Export is incomplete: ${title(issue)} ${clause}.`,
      detail: `${chatListLabel(issue.name)} ${clause}.`,
    };
  }
  const named = issues.slice(0, maxNames).map(title);
  const extra = issues.length - named.length;
  const listed =
    extra > 0 ? `${named.join(', ')}, and ${extra} more` : named.join(', ');
  return {
    toast: `Export is incomplete: ${listed}. Open the operation log.`,
    detail: `${issues.length} chats are incomplete. Open the operation log.`,
  };
}

/** Human stage label for the sidebar and native progress reporter. */
export function phaseMessage(
  phase: TransferPhase,
  metrics: TransferPhaseMetrics = {},
): string {
  if (
    typeof metrics.processed === 'number' &&
    typeof metrics.total === 'number' &&
    metrics.total > 0
  ) {
    const counts = `${metrics.processed.toLocaleString('en-US')} / ${metrics.total.toLocaleString('en-US')}`;
    if (phase === 'prepare') return `Preparing message records · ${counts}`;
    if (phase === 'read') return `Reading selected chats · ${counts}`;
    if (phase === 'collect') return `Collecting chat dependencies · ${counts}`;
  }
  switch (phase) {
    case 'read':
      return 'Reading export file…';
    case 'validate':
      return 'Validating export…';
    case 'collect':
      return 'Collecting chat dependencies…';
    case 'prepare':
      return 'Preparing message records…';
    case 'selection':
      return 'Reading selected chats…';
    case 'backup':
      return 'Creating backups…';
    case 'write':
      return 'Writing data…';
    case 'global-commit':
      return 'Chat data saved; updating workspace…';
    case 'workspace-commit':
      return 'Workspace updated…';
    case 'verify':
      return 'Verifying imported data…';
    default:
      return 'Working…';
  }
}

/** Last-transfer copy: title, detail, toast, and optional named items. */
export interface ImportNotice {
  /** Status heading in the sidebar. */
  title: string;
  /** One-line explanation. */
  detail: string;
  /** Toast text. */
  toast: string;
  /** Named chats listed under the status. */
  items: string[];
  /** True when the user should quit and reopen Cursor to reread written chats. */
  restart: boolean;
  /** Whether the run completed or was incomplete. */
  status: 'completed' | 'incomplete';
}

/** Display name for a chat row, with an optional reason suffix. */
function chatItemLabel(chat: {
  composerId: string;
  name?: string;
  reason?: string;
}): string {
  const raw = typeof chat.name === 'string' ? chat.name.trim() : '';
  const name = raw ? raw.slice(0, 120) : chat.composerId;
  return chat.reason ? `${name} — ${chat.reason}` : name;
}

/** Calm Last-transfer copy for import results. */
export function formatImportNotice(result: ImportResult): ImportNotice {
  const restoredChats = result.restoredChats || [];
  const restored = result.restored ?? restoredChats.length;
  const items = [
    ...result.alreadyImportedChats.map(chatItemLabel),
    ...result.newVersionChats.map(chatItemLabel),
    ...restoredChats.map(chatItemLabel),
    ...result.skippedChats.map((chat) =>
      chatItemLabel({ ...chat, reason: chat.reason }),
    ),
  ];
  /** Format `1 chat` versus `N chats` for the import notice. */
  const chats = (n: number) => `${n} chat${n === 1 ? '' : 's'}`;
  const already =
    result.alreadyImported > 0
      ? ` · ${result.alreadyImported} already imported`
      : '';
  const restart = result.imported > 0;
  const title = `Imported ${chats(result.imported)}${already}`;
  const load = 'Quit and reopen Cursor to load them.';
  // Incompleteness has priority over no-op and new-version presentation.
  if (result.historyOnly > 0 || result.skipped > 0) {
    const details: string[] = [];
    if (result.historyOnly > 0) {
      details.push(
        `${chats(result.historyOnly)} ${result.historyOnly === 1 ? 'has' : 'have'} missing data. You may not be able to continue ${result.historyOnly === 1 ? 'this chat' : 'these chats'}.`,
      );
    }
    if (result.skipped > 0)
      details.push(
        `${chats(result.skipped)} ${result.skipped === 1 ? 'was' : 'were'} skipped.`,
      );
    if (restart) details.push(load);
    const detail = details.join(' ');
    return {
      title,
      detail,
      toast: `${title}. ${detail}`,
      items,
      restart,
      status: 'incomplete',
    };
  }
  if (result.imported === 0 && result.alreadyImported > 0) {
    return {
      title: 'These chats are already imported',
      detail: 'No changes made.',
      toast: 'These chats are already imported. No changes made.',
      items,
      restart: false,
      status: 'completed',
    };
  }
  if (
    restored > 0 &&
    result.imported === restored &&
    result.newVersions === 0
  ) {
    const loadRestored =
      restored === 1
        ? 'Quit Cursor and reopen it to load the restored chat.'
        : 'Quit Cursor and reopen it to load the restored chats.';
    const restoredTitle = `Restored ${chats(restored)}${already}`;
    return {
      title: restoredTitle,
      detail: loadRestored,
      toast: `${restoredTitle}. ${loadRestored}`,
      items,
      restart,
      status: 'completed',
    };
  }
  if (
    result.newVersions > 0 &&
    result.imported === result.newVersions &&
    result.alreadyImported === 0
  ) {
    const n = result.newVersions;
    const title = `Added ${n} updated chat version${n === 1 ? '' : 's'}`;
    const detail = `${n === 1 ? 'A separate copy was' : 'Separate copies were'} created. Your existing ${n === 1 ? 'chat was' : 'chats were'} kept. ${load}`;
    return {
      title,
      detail,
      toast: `${title}. ${detail}`,
      items,
      restart,
      status: 'completed',
    };
  }
  return {
    title,
    detail: restart ? load : 'No changes made.',
    toast: restart ? `${title}. ${load}` : title,
    items,
    restart,
    status: 'completed',
  };
}

/** Fire a success toast without holding the transfer lock. */
export function notifyCompletion(
  show: () => PromiseLike<string | undefined>,
  onChoice: (choice: string | undefined) => void,
  onError: () => void,
): void {
  void Promise.resolve(show()).then(onChoice, onError);
}
