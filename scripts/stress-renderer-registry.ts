import { performance } from 'node:perf_hooks';
import {
  auxiliaryKeysFromJson,
  remapChatKvJson,
} from '../src/chat-kv-registry';

/** Renderer-registry stress scenario bounds. */
const defaultStressRecordCount = 100_000;
const maximumStressRecordCount = 1_000_000;

/** Opt-in CPU/RSS probe for the public renderer registry helpers. */
function main(): void {
  const count = Number(
    process.env.CCT_STRESS_RECORDS || defaultStressRecordCount,
  );

  if (
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > maximumStressRecordCount
  )
    throw new Error('CCT_STRESS_RECORDS must be an integer from 1 to 1000000.');

  const before = process.memoryUsage().rss;
  let peak = before;

  const sample = () => {
    peak = Math.max(peak, process.memoryUsage().rss);
  };

  const checkpointIds = Array.from({ length: count }, (_, index) =>
    String(index).padStart(12, '0'),
  );

  sample();

  const started = performance.now();
  const keys = auxiliaryKeysFromJson({ checkpointIds });

  sample();

  const remapped = remapChatKvJson(
    { checkpointIds },
    new Map(),
    new Map(checkpointIds.map((id) => [id, `r-${id}`])),
  ) as { checkpointIds: string[] };

  sample();

  if (keys.size !== count || remapped.checkpointIds.length !== count)
    throw new Error('Stress probe produced an incomplete result.');

  process.stdout.write(
    `${JSON.stringify(
      {
        records: count,
        elapsedMs: Math.round(performance.now() - started),
        rssBeforeBytes: before,
        rssPeakBytes: peak,
        rssDeltaBytes: peak - before,
        scope: 'single process; synthetic registry helper workload',
      },
      null,
      2,
    )}\n`,
  );
}

main();
