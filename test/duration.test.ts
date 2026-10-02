import test from 'node:test';
import assert from 'node:assert/strict';
import { humanDuration, durationField } from '../src/duration';
import { sqliteTimeoutError } from '../src/sqlite-timeout';

test('duration labels cover subsecond, minute, hour and invalid values', () => {
  for (const [ms, expected] of [
    [0, '0 ms'],
    [999, '999 ms'],
    [1000, '1s'],
    [59999, '59s'],
    [60000, '1m 0s'],
    [87682, '1m 27s'],
    [3661000, '1h 1m 1s'],
    [-1, 'unknown'],
    [NaN, 'unknown'],
    [Infinity, 'unknown'],
  ] as const) {
    assert.equal(humanDuration(ms), expected);
  }

  assert.equal(durationField('elapsedMs', 87682), 'elapsedMs=87682 (1m 27s)');
  assert.match(sqliteTimeoutError(600000).message, /600000 ms \(10m 0s\)/);
});
