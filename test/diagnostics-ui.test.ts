import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectChecks,
  diagnosticTitle,
  formatDiagnosticReport,
  type DiagnosticReport,
} from '../src/diagnostics-report';

/** Shared diagnostics identity; tests supply their own checks. */
const base: Omit<DiagnosticReport, 'checks'> = {
  generatedAt: '2026-09-27T13:42:45.123Z',
  editorName: 'Cursor',
  editorApiVersion: '1.128.0',
  extensionVersion: '0.0.26',
};

test('report labels VS Code API separately from the editor name', () => {
  const text = formatDiagnosticReport({
    ...base,
    checks: [{ label: 'Host', status: 'ok', summary: 'Local UI host' }],
  });
  assert.match(text, /Editor: Cursor/);
  assert.match(text, /VS Code API: 1\.128\.0/);
  assert.doesNotMatch(text, /Cursor version 1\.128/);
});

test('title follows the actual check results', () => {
  assert.equal(
    diagnosticTitle({
      ...base,
      checks: [{ label: 'A', status: 'ok', summary: 'fine' }],
    }),
    'Diagnostics: checks passed',
  );
  assert.equal(
    diagnosticTitle({
      ...base,
      checks: [{ label: 'A', status: 'warning', summary: 'limit' }],
    }),
    'Diagnostics: needs attention',
  );
  assert.equal(
    diagnosticTitle({
      ...base,
      checks: [{ label: 'A', status: 'error', summary: 'missing' }],
    }),
    'Diagnostics: unable to complete checks',
  );
});

test('collectChecks keeps other probes when one fails', async () => {
  const checks = await collectChecks([
    {
      label: 'ok',
      run: async () => ({ label: 'ok', status: 'ok', summary: 'yes' }),
    },
    {
      label: 'boom',
      run: async () => {
        throw new Error('nope');
      },
    },
  ]);
  assert.equal(checks[0].status, 'ok');
  assert.equal(checks[1].status, 'error');
  assert.equal(checks[1].label, 'boom');
});
