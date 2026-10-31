import { fork, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** Stop a synchronously busy transfer worker if its supervising host disappears. */
export function guardSqliteParent(owner = process.ppid): ChildProcess {
  const compiled = path.join(__dirname, 'sqlite-orphan-watchdog.js');

  const script = fs.existsSync(compiled)
    ? compiled
    : path.join(__dirname, 'sqlite-orphan-watchdog.ts');

  const child = fork(script, [String(owner), String(process.pid)], {
    execArgv: script.endsWith('.ts') ? ['--import', 'tsx'] : [],
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });

  child.on('error', () => process.exit(1));
  child.unref();
  child.channel?.unref();

  return child;
}
