import test from 'node:test';
import assert from 'node:assert/strict';
import { startOperationLog } from '../src/operation-log';
import { formatLogLine, logTimestamp } from '../src/log-format';
import { asTransitLog } from '../src/output-ui';
import type { TransferPhase } from '../src/types';

/** Collect real output boundary lines. */
function sink() {
  const lines: string[] = [];

  const channel = asTransitLog({
    appendLine: (value) => lines.push(value),
    show: () => undefined,
    dispose: () => undefined,
  });

  return { lines, channel };
}

test('all phase names are readable sentences with bracketed levels and chat context', () => {
  const { lines, channel } = sink();
  const log = startOperationLog(channel, 'import');

  const phases: TransferPhase[] = [
    'selection',
    'read',
    'extract',
    'validate',
    'collect',
    'prepare',
    'write',
    'global-commit',
    'workspace-commit',
    'verify',
    'pack',
  ];

  for (const phase of phases)
    log.phase(phase, {
      chatName: 'my Chat',
      chatIndex: 1,
      chatTotal: 3,
      processed: 25,
      total: 100,
      unit: 'resources',
    });

  const verification = lines.find((line) =>
    line.includes('Verify imported chat data'),
  )!;

  assert.match(
    verification,
    /Chat 1 of 3 · chat="my Chat" · 25 \/ 100 resources/,
  );

  for (const line of lines) {
    assert.match(
      line,
      /^\[\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}[+-]\d\d:\d\d\] \[INFO\] [A-Z]/,
    );

    assert.equal((line.match(/\[INFO\]/g) || []).length, 1);

    assert.doesNotMatch(
      line,
      /INFO\] (verify|global-commit|workspace-commit|import)\b/,
    );
  }
});

test('phase heartbeats are throttled but completion is always logged', () => {
  const { lines, channel } = sink();
  const log = startOperationLog(channel, 'export');

  log.phase('collect', { processed: 0, total: 481 });
  log.phase('collect', { processed: 12, total: 481 });
  log.phase('collect', { processed: 481, total: 481 });
  assert.equal(lines.length, 3);
  assert.doesNotMatch(lines.join('\n'), /12 \/ 481/);
  assert.match(lines.at(-1)!, /481 \/ 481/);
});

test('file errors retain path, exact bytes, human bytes, severity and operation id', () => {
  const { lines, channel } = sink();
  const log = startOperationLog(channel, 'import');

  log.event({
    action: 'read file',
    status: 'failed',
    path: '/tmp/My chat/a.ndjson',
    chatName: 'A\nB',
    bytes: 1048576,
    errorCode: 'EACCES',
  });

  assert.match(lines.at(-1)!, /\[ERROR\] Read file failed/);
  assert.match(lines.at(-1)!, /bytes=1048576 \(1.00 MiB\)/);
  assert.match(lines.at(-1)!, /path="\/tmp\/My chat\/a.ndjson"/);
  assert.match(lines.at(-1)!, /chatName="A B"/);
  assert.match(lines.at(-1)!, /operation=[a-f0-9]{8}/);
  log.file('chats.zip', 1355426844);

  assert.match(
    lines.at(-1)!,
    /Selected archive file="chats.zip" bytes=1355426844/,
  );

  log.finish('failed', 'INVALID_JSON', new Error('broken\nrecord'));

  assert.match(
    lines.at(-1)!,
    /\[ERROR\] Import failed.*code=INVALID_JSON.*message="broken record"/,
  );

  const count = lines.length;

  log.fact('must not appear');
  log.finish('completed');
  assert.equal(lines.length, count);
});

test('free text and standalone messages use sentence case without changing values', () => {
  const { lines, channel } = sink();
  const log = startOperationLog(channel, 'export');

  log.note('unreadable chat name="iPhone"');
  log.fact('import summary: imported=2');
  channel.error('sqlite failed\npath=/tmp/MyFile');
  assert.match(lines[1]!, /\[WARN\] Unreadable chat name="iPhone"/);
  assert.match(lines[2]!, /\[INFO\] Import summary/);
  assert.match(lines[3]!, /\[ERROR\] Sqlite failed path=\/tmp\/MyFile/);
});

test('timestamp has an unambiguous local numeric offset, including fractional zones and DST', () => {
  const previous = process.env.TZ;

  try {
    const date = new Date('2026-10-01T10:40:48.802Z');

    for (const [tz, expected] of [
      ['UTC', '2026-10-01 10:40:48.802+00:00'],
      ['Europe/Moscow', '2026-10-01 13:40:48.802+03:00'],
      ['Asia/Kathmandu', '2026-10-01 16:25:48.802+05:45'],
      ['America/New_York', '2026-10-01 06:40:48.802-04:00'],
    ]) {
      process.env.TZ = tz;
      assert.equal(logTimestamp(date), expected);

      assert.equal(
        formatLogLine('INFO', 'read file', date),
        `[${expected}] [INFO] Read file`,
      );
    }

    process.env.TZ = 'America/New_York';

    assert.equal(
      logTimestamp(new Date('2026-01-01T01:00:00.000Z')),
      '2025-12-31 20:00:00.000-05:00',
    );
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test('duration fields retain exact milliseconds and human units without changing paths', () => {
  const { lines, channel } = sink();
  let now = 100;
  const log = startOperationLog(channel, 'import', () => now);

  log.event({
    action: 'Read file',
    status: 'completed',
    elapsedMs: 125,
    timeoutMs: 600000,
    path: '/tmp/elapsedMs=4000',
  });

  assert.match(lines.at(-1)!, /elapsedMs=125 \(125 ms\)/);
  assert.match(lines.at(-1)!, /timeoutMs=600000 \(10m 0s\)/);
  assert.match(lines.at(-1)!, /path="\/tmp\/elapsedMs=4000"/);
  now += 87682;
  log.finish('completed');
  assert.match(lines.at(-1)!, /elapsedMs=87682 \(1m 27s\)/);
  assert.equal(log.elapsedMs(), 87682);
  now += 9000;
  assert.equal(log.elapsedMs(), 87682);
});
