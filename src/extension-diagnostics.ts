import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import { inspectDatabase } from './db';
import {
  collectChecks,
  showDiagnosticsDialog,
  type DiagnosticCheck,
  type DiagnosticReport,
} from './diagnostics-ui';
import { config, storageOptions } from './extension-settings';
import { runtime } from './extension-state';
import { resolveSelectedWorkspace } from './operation-ui';
import * as paths from './paths';
import { ensureInitFile, findSqliteExecutable, sqliteVersion } from './sqlite';

/** Human host label; never show the numeric ExtensionKind. */
export function hostKindLabel(kind: vscode.ExtensionKind): string {
  return kind === vscode.ExtensionKind.UI ? 'Local UI host' : 'Workspace host';
}

/** Project kind without leaking a remote authority. */
export function projectKindLabel(): string {
  const folders = vscode.workspace.workspaceFolders || [];

  if (folders.length > 1) return 'Multi-root';
  const remote = vscode.env.remoteName || '';

  if (remote === 'wsl') return 'WSL';
  if (remote.startsWith('ssh-remote') || remote === 'ssh') return 'SSH';
  if (remote) return 'Remote';

  return folders.length ? 'Local' : 'No folder';
}

/** Redact home paths and SSH authorities from a shareable string. */
export function redact(value: string): string {
  const home = os.homedir();
  let out = value;

  if (home) out = out.split(home).join('~');

  return out.replace(/ssh-remote\+[^\s/]+/gi, 'ssh-remote+[redacted]');
}

/** Run one probe with a real timeout. */
export async function timedCheck(
  label: string,
  run: (signal: AbortSignal) => Promise<DiagnosticCheck>,
  timeoutMs = 8000,
): Promise<DiagnosticCheck> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  try {
    return await run(ac.signal);
  } catch (err) {
    if (ac.signal.aborted) {
      return { label, status: 'error', summary: 'Check timed out.' };
    }

    return {
      label,
      status: 'error',
      summary: redact(err instanceof Error ? err.message : String(err)),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Independent diagnostics; missing sqlite3 must not block the window. */
export async function collectDiagnosticReport(
  context: vscode.ExtensionContext,
): Promise<DiagnosticReport> {
  const { sqlitePath } = config();
  const executable = findSqliteExecutable(sqlitePath || undefined);

  const checks = await collectChecks([
    {
      label: 'SQLite CLI',
      run: () =>
        timedCheck('SQLite CLI', async (signal) => {
          if (!executable) {
            return {
              label: 'SQLite CLI',
              status: 'error',
              summary: 'sqlite3 was not found on this machine.',
            };
          }

          const tmp = path.join(context.globalStorageUri.fsPath, 'sqlite-init');

          await fs.promises.mkdir(tmp, { recursive: true });
          const initFile = await ensureInitFile(tmp);
          const version = await sqliteVersion(executable, initFile, signal);

          return {
            label: 'SQLite CLI',
            status: 'ok',
            summary: `Available, ${redact(version)}`,
          };
        }),
    },
    {
      label: 'Storage',
      run: () =>
        timedCheck('Storage', async () => {
          try {
            const userDir = paths.preferStorageRoot(storageOptions());
            const entries = paths.listWorkspaceEntries(userDir);
            const paired = entries.length > 0;

            return {
              label: 'Storage',
              status: paired ? 'ok' : 'warning',
              summary: paired
                ? `Paired workspace storage found (${entries.length} workspace(s)).`
                : 'No paired workspaceStorage databases were found.',
            };
          } catch (err) {
            return {
              label: 'Storage',
              status: 'error',
              summary: redact(err instanceof Error ? err.message : String(err)),
            };
          }
        }),
    },
    {
      label: 'Write contract',
      run: () =>
        timedCheck('Write contract', async (signal) => {
          if (!executable) {
            return {
              label: 'Write contract',
              status: 'unknown',
              summary: 'Skipped because sqlite3 is unavailable.',
            };
          }

          const tmp = path.join(context.globalStorageUri.fsPath, 'sqlite-init');

          await fs.promises.mkdir(tmp, { recursive: true });
          const initFile = await ensureInitFile(tmp);
          const userDir = paths.preferStorageRoot(storageOptions());
          const entries = paths.listWorkspaceEntries(userDir);

          const resolved = resolveSelectedWorkspace(
            runtime.sourceWorkspace,
            entries,
          );

          if (resolved.status !== 'ok') {
            return {
              label: 'Write contract',
              status: 'unknown',
              summary:
                'Choose a workspace to check its write contract. This does not inspect every stored project.',
            };
          }

          const entry = resolved.workspace;

          const ws = await inspectDatabase({
            executable,
            database: entry.workspaceDbPath,
            initFile,
            readOnly: true,
            signal,
            timeoutMs: 8000,
          });

          const gl = await inspectDatabase({
            executable,
            database: entry.globalDbPath,
            initFile,
            readOnly: true,
            signal,
            timeoutMs: 8000,
          });

          if (!gl.layout.canWriteGlobal || !ws.layout.canWriteWorkspace) {
            return {
              label: 'Write contract',
              status: 'warning',
              summary: redact(
                gl.layout.unsupportedReason ||
                  ws.layout.unsupportedReason ||
                  'Discovered schema is not writable.',
              ),
            };
          }

          return {
            label: 'Write contract',
            status: 'ok',
            summary: 'Known global and workspace write contract.',
          };
        }),
    },
  ]);

  return {
    generatedAt: new Date().toISOString(),
    editorName: vscode.env.appName,
    editorApiVersion: vscode.version,
    extensionVersion: String(context.extension.packageJSON.version),
    checks: [
      {
        label: 'Host',
        status: 'ok',
        summary: `${hostKindLabel(context.extension.extensionKind)}; project ${projectKindLabel()}`,
      },
      ...checks,
    ],
  };
}

/** Native diagnostics window; does not write to the operations channel. */
export async function doDiagnostics(opts: {
  /** Extension host context used to locate Cursor storage. */
  context: vscode.ExtensionContext;
}): Promise<void> {
  const report = await collectDiagnosticReport(opts.context);

  await showDiagnosticsDialog(report);
}
