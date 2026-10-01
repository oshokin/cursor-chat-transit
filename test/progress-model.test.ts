import test from 'node:test';
import assert from 'node:assert/strict';
import { ProgressModel } from '../src/progress-model';

test('archive ETA survives many changing paths and reaches completion', () => {
  const model = new ProgressModel('import', 0);
  const base = { scope: 'archive', total: 100, unit: 'bytes' };

  model.update('extract', { ...base, file: 'a', processed: 0 }, 0);

  for (let i = 1; i <= 25; i++) {
    model.update(
      'extract',
      { ...base, file: `part-${i}`, processed: i },
      i * 80,
    );
  }

  assert.equal(model.snapshot(2000).progress, 25);
  assert.match(model.snapshot(2000).timingLabel, /0m 06s left in this step/);
  assert.match(model.snapshot(2000).currentItem, /part-25/);
  model.update('extract', { ...base, processed: 100 }, 8000);
  assert.match(model.snapshot(8000).timingLabel, /Step complete/);
  assert.equal(model.snapshot(8000).progress, 100);
});

test('verification with no byte progress does not pretend to keep estimating', () => {
  const model = new ProgressModel('import', 0);

  model.update('verify', { processed: 0, total: 100, unit: 'resources' }, 0);

  model.update(
    'verify',
    { processed: 25, total: 100, unit: 'resources' },
    2000,
  );

  assert.match(model.snapshot(2000).timingLabel, /0m 06s left/);

  // Heartbeat with the same counter must not hide stalled measurement.
  model.update(
    'verify',
    { processed: 25, total: 100, unit: 'resources' },
    11000,
  );

  assert.match(
    model.snapshot(12000).timingLabel,
    /No measured progress for 0m 10s/,
  );

  model.update(
    'verify',
    { processed: 50, total: 100, unit: 'resources' },
    13000,
  );

  assert.match(model.snapshot(13000).timingLabel, /left in this step/);
});

test('new phase, chat, unit and decreasing counters reset the estimator', () => {
  const model = new ProgressModel('import', 0);

  model.update(
    'prepare',
    { processed: 0, total: 100, chatIndex: 1, unit: 'resources' },
    0,
  );

  model.update(
    'prepare',
    { processed: 50, total: 100, chatIndex: 1, unit: 'resources' },
    2000,
  );

  for (const [i, metrics] of [
    { processed: 1, total: 100, chatIndex: 1, unit: 'resources' },
    { processed: 10, total: 100, chatIndex: 2, unit: 'resources' },
    { processed: 20, total: 100, chatIndex: 2, unit: 'messages' },
  ].entries()) {
    model.update('prepare', metrics, 3000 + i * 1000);

    const timing = model.snapshot(3000 + i * 1000).timingLabel;

    assert.match(timing, /^Elapsed /);
    assert.doesNotMatch(timing, /left in|Measuring|Time remaining/);
  }

  assert.doesNotMatch(model.snapshot(60000).timingLabel, /estimating/);
});

test('unknown totals, invalid numbers and late initial samples never invent an ETA', () => {
  for (const metrics of [
    {},
    { processed: 2, total: NaN },
    { processed: Infinity, total: 10 },
    { processed: -1, total: 10 },
  ]) {
    const model = new ProgressModel('import', 0);

    model.update('verify', metrics, 1000);
    assert.equal(model.snapshot(5000).progress, undefined);
    assert.doesNotMatch(model.snapshot(5000).timingLabel, /left in/);
  }

  const model = new ProgressModel('import', 0);

  model.update('verify', { processed: 90, total: 100 }, 9000);
  assert.doesNotMatch(model.snapshot(9000).timingLabel, /left in/);
});

test('export and import stages contain only work that is performed', () => {
  const exporting = new ProgressModel('export', 0);

  exporting.update('read', {}, 1000);
  assert.equal(exporting.snapshot(1000).stageLabel, 'Stage 2 of 4');
  exporting.update('pack', {}, 2000);
  assert.equal(exporting.snapshot(2000).stageLabel, 'Stage 4 of 4');
  const importing = new ProgressModel('import', 0);

  importing.update('prepare', {}, 1000);
  assert.equal(importing.snapshot(1000).stageLabel, 'Stage 3 of 5');
  importing.update('verify', {}, 2000);
  assert.equal(importing.snapshot(2000).stageLabel, 'Stage 5 of 5');
});
