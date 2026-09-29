import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { runTests } from '@vscode/test-electron';

/** Compile the extension, sidebar client and host test, then run the VS Code smoke. */
async function main(): Promise<void> {
  const root = path.resolve(__dirname, '..');
  const compile = spawnSync(
    process.execPath,
    [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'],
    { cwd: root, stdio: 'inherit', shell: false },
  );
  if (compile.status !== 0) process.exit(compile.status ?? 1);
  const host = spawnSync(
    process.execPath,
    [
      path.join(root, 'node_modules/typescript/bin/tsc'),
      '-p',
      'tsconfig.host.json',
    ],
    { cwd: root, stdio: 'inherit', shell: false },
  );
  if (host.status !== 0) process.exit(host.status ?? 1);
  const webview = spawnSync(
    process.execPath,
    [
      path.join(root, 'node_modules/typescript/bin/tsc'),
      '-p',
      'tsconfig.webview.json',
    ],
    { cwd: root, stdio: 'inherit', shell: false },
  );
  if (webview.status !== 0) process.exit(webview.status ?? 1);
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cct-host-'));
  try {
    await runTests({
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(root, 'out/test-host/index.js'),
      launchArgs: [
        '--disable-extensions',
        `--user-data-dir=${path.join(tmp, 'data')}`,
        `--extensions-dir=${path.join(tmp, 'ext')}`,
      ],
      version: process.env.VSCODE_TEST_VERSION || '1.85.0',
    });
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
