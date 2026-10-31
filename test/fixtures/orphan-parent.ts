import { fork } from 'node:child_process';
import path from 'node:path';

const child = fork(
  path.resolve('test/fixtures/native-watchdog.ts'),
  [process.argv[2]!],
  {
    execArgv: ['--import', 'tsx'],
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  },
);

child.on('message', (message) => {
  if ((message as { type: string }).type === 'entered')
    process.send?.({ type: 'orphaned' }, () => process.exit(0));
});
