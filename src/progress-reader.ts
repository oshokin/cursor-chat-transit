import { stat } from 'node:fs/promises';
import { readNdjson, type NdjsonRecord } from './ndjson-io';
import type { TransferContext } from './types';

/** Measure a bounded NDJSON part while its consumer validates records. */
export async function* readMeasuredNdjson(
  file: string,
  /** Name used when the value is rejected. */
  label: string,
  /** Transfer hooks, timeouts, and cancellation. */
  ctx: TransferContext,
): AsyncGenerator<NdjsonRecord> {
  const total = (await stat(file)).size;
  let last = performance.now();

  /** Report progress for this step. */
  const report = (
    /** Bytes validated so far. */
    processed: number,
  ) =>
    ctx.onPhase?.('validate', {
      scope: file,
      file,
      processed,
      total,
      unit: 'bytes',
    });

  report(0);
  for await (const row of readNdjson(file, label, ctx.signal, (processed) => {
    if (performance.now() - last >= 250) {
      last = performance.now();
      report(processed);
    }
  }))
    yield row;
  report(total);
}
