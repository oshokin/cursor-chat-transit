import test from 'node:test';
import assert from 'node:assert/strict';
import { startOperationLog } from '../src/operation-log';
import type { TransitLog } from '../src/output-ui';

/** Collect log lines from a stub TransitLog. */
function sink() {
  const lines: string[] = [];
  const channel: TransitLog = {
    appendLine: (value) => lines.push(value),
    info: (message) => lines.push(message),
    warn: (message) => lines.push(message),
    error: (message) => lines.push(message),
    show: () => undefined,
    dispose: () => undefined,
  };
  return { lines, channel };
}

test('phase log skips per-item ticks and notes name the chat', () => {
  const { lines, channel } = sink();
  const log = startOperationLog(channel, 'export');
  log.phase('collect', { chats: 7, processed: 12, total: 481 });
  log.phase('collect', { chats: 7, processed: 481, total: 481 });
  log.note(
    'unreadable chat id=11111111-1111-4111-8111-111111111111 name="Fix SSH" reason=missing-body',
  );
  const text = lines.join('\n');
  assert.doesNotMatch(text, /processed=12/);
  assert.match(text, /processed=481/);
  assert.match(text, /unreadable chat id=11111111-1111-4111-8111-111111111111/);
  assert.match(text, /Fix SSH/);
  assert.match(text, /missing-body/);
});
