import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { mapInBatches, FILE_READ_CONCURRENCY } from '../src/bounded-io';

test('bounded file reads overlap, retain input order, and cap active work', async () => {
  assert.ok(FILE_READ_CONCURRENCY >= 1 && FILE_READ_CONCURRENCY <= 4);

  let active = 0,
    peak = 0;

  const values: number[] = [];

  for await (const batch of mapInBatches(
    [3, 2, 1, 0, 4],
    async (value) => {
      peak = Math.max(peak, ++active);
      await setTimeout(value);
      active--;

      return value;
    },
    undefined,
    3,
  ))
    values.push(...batch);
  assert.deepEqual(values, [3, 2, 1, 0, 4]);
  assert.equal(peak, 3);
  assert.equal(active, 0);
});

test('file read failure drains active tasks and starts no later batch', async () => {
  const started: number[] = [],
    finished: number[] = [];

  await assert.rejects(async () => {
    for await (const batch of mapInBatches(
      [0, 1, 2, 3],
      async (value) => {
        started.push(value);
        if (!value) throw new Error('read failed');
        await setTimeout(10);
        finished.push(value);

        return value;
      },
      undefined,
      2,
    ))
      assert.fail(`Unexpected results: ${batch}`);
  }, /read failed/);

  assert.deepEqual(started, [0, 1]);
  assert.deepEqual(finished, [1]);
});

test('cancelled file scan drains its current batch without exposing partial results', async () => {
  const abort = new AbortController();
  const finished: number[] = [];

  await assert.rejects(async () => {
    for await (const batch of mapInBatches(
      [0, 1, 2],
      async (value) => {
        await setTimeout(1);
        finished.push(value);
        if (!value) abort.abort();

        return value;
      },
      abort.signal,
      2,
    ))
      assert.fail(`Unexpected results: ${batch}`);
  }, /abort/i);

  assert.deepEqual(finished, [0, 1]);
});
