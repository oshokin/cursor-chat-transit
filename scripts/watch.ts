/**
 * Compile the extension host and sidebar client in watch mode.
 * If either child exits, the other is stopped.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';

/** Path to the workspace TypeScript compiler. */
const tsc = path.resolve('node_modules', 'typescript', 'bin', 'tsc');

/** Watch children for the extension host and the sidebar client. */
const children = ['tsconfig.json', 'tsconfig.webview.json'].map((config) =>
  spawn(process.execPath, [tsc, '-p', config, '-w', '--preserveWatchOutput'], {
    stdio: 'inherit',
    shell: false,
  }),
);

for (const child of children) {
  child.on('error', (error) => {
    console.error(error);
    for (const other of children) other.kill();
    process.exitCode = 1;
  });

  child.on('exit', (code) => {
    for (const other of children) {
      if (other !== child && other.exitCode === null) other.kill();
    }

    process.exit(code ?? 1);
  });
}
