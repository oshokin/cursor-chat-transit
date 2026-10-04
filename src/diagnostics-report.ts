/** One redacted diagnostics probe shown in the report. */
export interface DiagnosticCheck {
  /** Short probe name shown in the report. */
  label: string;
  /** Outcome of this probe. */
  status: 'ok' | 'warning' | 'error' | 'unknown';
  /** One-line redacted summary. */
  summary: string;
}

/** Shareable diagnostics snapshot: editor identity plus ordered checks. */
export interface DiagnosticReport {
  /** ISO timestamp when the report was built. */
  generatedAt: string;
  /** Display name of the host editor. */
  editorName: string;
  /** VS Code API version reported by the host. */
  editorApiVersion: string;
  /** This extension's package version. */
  extensionVersion: string;
  /** Probes in display order. */
  checks: DiagnosticCheck[];
}

/** Keep diagnostics display bounded, plain text, and on one line per check. */
export function displayLine(
  /** Diagnostic value to print. */
  value: string,
  maxLength = 150,
): string {
  return value.replace(/[\r\n\t]/g, ' ').slice(0, maxLength);
}

/** Render a shareable report. The collector must already have redacted paths. */
export function formatDiagnosticReport(
  /** Progress callback. */
  report: DiagnosticReport,
): string {
  return [
    'Cursor Chat Transit — Diagnostics',
    `Checked: ${report.generatedAt}`,
    `Editor: ${displayLine(report.editorName)}`,
    `VS Code API: ${displayLine(report.editorApiVersion)}`,
    `Extension: ${displayLine(report.extensionVersion)}`,
    '',
    ...report.checks.map(
      (check) =>
        `[${check.status.toUpperCase()}] ${displayLine(check.label)}: ${displayLine(check.summary)}`,
    ),
    '',
    'These checks do not prove that chat continuation works in Cursor.',
  ].join('\n');
}

/** Overall title from the actual check results. */
export function diagnosticTitle(
  /** Progress callback. */
  report: DiagnosticReport,
): string {
  if (report.checks.some((check) => check.status === 'error')) {
    return report.checks.every(
      (check) => check.status === 'error' || check.status === 'unknown',
    )
      ? 'Diagnostics: unable to complete checks'
      : 'Diagnostics: needs attention';
  }

  if (report.checks.some((check) => check.status !== 'ok')) {
    return 'Diagnostics: needs attention';
  }

  return 'Diagnostics: checks passed';
}

/** Collect independent checks even when SQLite or one storage root is unavailable. */
export async function collectChecks(
  probes: ReadonlyArray<{
    /** Name copied onto a failed check when the probe itself throws. */
    label: string;
    /** Run one independent diagnostic. */
    run(): Promise<DiagnosticCheck>;
  }>,
): Promise<DiagnosticCheck[]> {
  const results = await Promise.allSettled(
    probes.map((/** One diagnostic probe. */ probe) => probe.run()),
  );

  return results.map((result, index) =>
    result.status === 'fulfilled'
      ? result.value
      : {
          label: probes[index].label,
          status: 'error',
          summary: 'Check could not be completed. Retry Diagnostics.',
        },
  );
}
