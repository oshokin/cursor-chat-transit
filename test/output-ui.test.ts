import test from 'node:test';
import assert from 'node:assert/strict';
import { asTransitLog, revealOutput } from '../src/output-ui';

test('explicit log action selects the channel then focuses the Output view', async () => {
  const shown: boolean[] = [];
  const commands: string[] = [];
  await revealOutput(
    {
      show: (preserveFocus?: boolean) => shown.push(Boolean(preserveFocus)),
    },
    {
      executeCommand: async (command) => {
        commands.push(command);
      },
    },
  );
  assert.deepEqual(shown, [true, false]);
  assert.deepEqual(commands, ['workbench.view.output']);
});

test('Output view command failure still focuses the channel', async () => {
  const shown: boolean[] = [];
  await revealOutput(
    {
      show: (preserveFocus?: boolean) => shown.push(Boolean(preserveFocus)),
    },
    {
      executeCommand: async () => {
        throw new Error('missing command');
      },
    },
  );
  assert.deepEqual(shown, [true, false]);
});

test('plain OutputChannel wrapper keeps info/warn/error as lines', () => {
  const lines: string[] = [];
  const log = asTransitLog({
    appendLine: (value) => lines.push(value),
    show: () => undefined,
    dispose: () => undefined,
  });
  log.info('started');
  log.warn('incomplete');
  log.error('failed');
  assert.deepEqual(lines, ['started', 'incomplete', 'failed']);
});
