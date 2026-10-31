import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { runTests, TestRunFailedError } from '@vscode/test-electron';

/** Retry and deadline policy for the network-dependent VS Code host smoke. */
const hostDownloadAttempts = 3;
const hostSmokeTimeoutMs = 60_000;
const hostRetryBackoffMs = 5_000;
/** Bound recursive error inspection in case an error contains cycles. */
const downloadErrorPartLimit = 20;

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
    await runHost(root, tmp);
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }
}

/** Download VS Code and run the smoke. A dropped connection is tried again. */
async function runHost(root: string, tmp: string): Promise<void> {
  let failure: unknown;

  for (let attempt = 1; attempt <= hostDownloadAttempts; attempt++) {
    try {
      await runTests({
        extensionDevelopmentPath: root,
        extensionTestsPath: path.join(root, 'out/test-host/index.js'),
        launchArgs: [
          '--disable-extensions',
          ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []),
          `--user-data-dir=${path.join(tmp, 'data')}`,
          `--extensions-dir=${path.join(tmp, 'ext')}`,
        ],
        version: process.env.VSCODE_TEST_VERSION || '1.128.0',
        timeout: hostSmokeTimeoutMs,
      });

      return;
    } catch (error) {
      failure = error;
      if (
        attempt === hostDownloadAttempts ||
        error instanceof TestRunFailedError ||
        !downloadFailure(error)
      )
        throw error;

      console.error(
        `VS Code download failed (${attempt} of ${hostDownloadAttempts}). Retrying.`,
      );

      await new Promise((resolve) =>
        setTimeout(resolve, attempt * hostRetryBackoffMs),
      );
    }
  }

  throw failure;
}

/** True when the update service or CDN did not answer. A failed smoke is not retried. */
function downloadFailure(error: unknown): boolean {
  const text: string[] = [];

  const visit = (value: unknown): void => {
    if (
      text.length > downloadErrorPartLimit ||
      value === undefined ||
      value === null
    )
      return;

    if (typeof value === 'string') {
      text.push(value);

      return;
    }

    if (value instanceof Error) {
      text.push(value.message);
      if (
        'code' in value &&
        (typeof value.code === 'string' || typeof value.code === 'number')
      )
        text.push(String(value.code));
      if (value instanceof AggregateError)
        for (const item of value.errors) visit(item);
      visit(value.cause);
    }
  };

  visit(error);

  return /ETIMEDOUT|ENETUNREACH|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|Failed to download and unzip VS Code/i.test(
    text.join('\n'),
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
