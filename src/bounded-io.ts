import { availableParallelism } from 'node:os';

/** Small I/O window, not one memory-heavy job per logical CPU. */
export const FILE_READ_CONCURRENCY = Math.min(4, availableParallelism());

/** Preserve order and drain every started task before failure or cleanup. */
export async function* mapInBatches<T, R>(
  /** Items processed in order. */
  items: readonly T[],
  run: (item: T) => Promise<R>,
  signal?: AbortSignal,
  /** Maximum number of tasks started at once. */
  concurrency = FILE_READ_CONCURRENCY,
): AsyncGenerator<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4)
    throw new Error('File read concurrency must be between 1 and 4.');

  for (let index = 0; index < items.length; index += concurrency) {
    signal?.throwIfAborted();

    const results = await Promise.allSettled(
      items.slice(index, index + concurrency).map((item) =>
        Promise.resolve().then(() => {
          signal?.throwIfAborted();

          return run(item);
        }),
      ),
    );

    const failure = results.find((result) => result.status === 'rejected');

    if (failure?.status === 'rejected') throw failure.reason;
    signal?.throwIfAborted();

    yield results.map((result) => (result as PromiseFulfilledResult<R>).value);
  }
}
