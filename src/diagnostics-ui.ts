import * as vscode from 'vscode';
import {
  diagnosticTitle,
  displayLine,
  formatDiagnosticReport,
  type DiagnosticReport,
} from './diagnostics-report';

/** Diagnostics types owned by the report module. */
export type { DiagnosticCheck, DiagnosticReport } from './diagnostics-report';
export {
  collectChecks,
  diagnosticTitle,
  formatDiagnosticReport,
} from './diagnostics-report';

/** Show a native modal on explicit request; keep the operation output free of diagnostics. */
export async function showDiagnosticsDialog(
  report: DiagnosticReport,
): Promise<void> {
  const text = formatDiagnosticReport(report);

  const detail = [
    `${displayLine(report.editorName)} · Extension ${displayLine(report.extensionVersion)}`,
    `VS Code API ${displayLine(report.editorApiVersion)}`,
    '',
    ...report.checks
      .slice(0, 8)
      .map(
        (check) =>
          `${check.status.toUpperCase()} — ${displayLine(check.label)}: ${displayLine(check.summary, 100)}`,
      ),
    ...(report.checks.length > 8
      ? ['Additional checks are in the report.']
      : []),
    '',
    'Sharing report: paths and connection names are redacted.',
  ].join('\n');

  const choice = await vscode.window.showInformationMessage(
    diagnosticTitle(report),
    { modal: true, detail },
    { title: 'Copy report' },
    { title: 'Close', isCloseAffordance: true },
  );

  if (choice?.title === 'Copy report')
    await vscode.env.clipboard.writeText(text);
}
