import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import type { DiagnosticReport } from '../src/diagnostics-report';

test('diagnostics has exactly Copy report and Close; only Copy writes the clipboard', async () => {
  const loader = Module as unknown as {
    _load: (name: string, ...rest: unknown[]) => unknown;
  };

  const original = loader._load;
  const copied: string[] = [];
  let choice: string | undefined = 'Copy report';
  let buttons: Array<{ title: string; isCloseAffordance?: boolean }> = [];

  loader._load = function (name, ...rest) {
    if (name === 'vscode')
      return {
        window: {
          showInformationMessage: async (
            _message: string,
            options: { modal: boolean },
            ...items: typeof buttons
          ) => {
            assert.equal(options.modal, true);
            buttons = items;

            return items.find((item) => item.title === choice);
          },
        },
        env: {
          clipboard: {
            writeText: async (text: string) => {
              copied.push(text);
            },
          },
        },
      };

    return original.call(this, name, ...rest);
  };

  let show: typeof import('../src/diagnostics-ui').showDiagnosticsDialog;

  try {
    show = (
      require('../src/diagnostics-ui') as typeof import('../src/diagnostics-ui')
    ).showDiagnosticsDialog;
  } finally {
    loader._load = original;
  }

  const report: DiagnosticReport = {
    generatedAt: '2026-10-01T00:00:00Z',
    editorName: 'Cursor',
    editorApiVersion: '1.85',
    extensionVersion: '1.0.0',
    checks: [],
  };

  await show(report);

  assert.deepEqual(buttons, [
    { title: 'Copy report' },
    { title: 'Close', isCloseAffordance: true },
  ]);

  assert.equal(copied.length, 1);
  assert.match(copied[0], /Cursor Chat Transit/);
  choice = 'Close';
  await show(report);
  choice = undefined;
  await show(report);
  assert.equal(copied.length, 1);
});
