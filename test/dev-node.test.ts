import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Repository root used to locate the wrapper scripts. */
const root = path.resolve(__dirname, '..');
/** Absolute PowerShell 5.1 host used on Windows; POSIX uses `sh`. */
const powershellExe = path.join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
);
/** spawn() argv that invokes the platform runner without a nested `.cmd`. */
const prefix =
  process.platform === 'win32'
    ? [
        powershellExe,
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.join(root, 'scripts', 'dev-node.ps1'),
      ]
    : ['sh', path.join(root, 'scripts', 'dev-node.sh')];

/** Run a command through `dev-node` and capture stdout, stderr, and exit status. */
function run(
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<{ status: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(prefix[0]!, [...prefix.slice(1), '--', ...args], {
      cwd: opts.cwd || root,
      env: opts.env || process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`dev-node timed out: ${args.join(' ')}`));
    }, opts.timeoutMs ?? 20_000);
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString();
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (status) => {
      clearTimeout(timer);
      resolve({ status, out, err });
    });
  });
}

test('dev-node forwards stdout and a numeric exit code', async () => {
  const ok = await run([
    process.execPath,
    '-e',
    "process.stdout.write('wrapper-ok')",
  ]);
  assert.equal(ok.status, 0, ok.err);
  assert.match(ok.out, /wrapper-ok/);
  const failed = await run([process.execPath, '-e', 'process.exit(7)']);
  assert.equal(failed.status, 7, failed.err);
});

test('dev-node keeps arguments that contain spaces', async () => {
  const result = await run([
    process.execPath,
    '-e',
    'process.stdout.write(JSON.stringify(process.argv))',
    'hello world',
  ]);
  assert.equal(result.status, 0, result.err);
  assert.match(result.out, /hello world/);
});

test('dev-node npm branch reports a version before exit', async () => {
  const result = await run(['npm', '--version']);
  assert.equal(result.status, 0, result.err);
  assert.match(result.out, /\d+\.\d+/);
});

test('dev-node streams watch-like output before the process exits', async () => {
  const fixture = path.join(root, 'test', 'fixtures', 'dev-node-watch.cjs');
  const child = spawn(
    prefix[0]!,
    [...prefix.slice(1), '--', process.execPath, fixture],
    {
      cwd: root,
      env: process.env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  let out = '';
  let err = '';
  let readySeen = false;
  const exit = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code));
  });
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`watch handshake timed out: ${out}\n${err}`));
    }, 10_000);
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      if (out.includes('READY')) {
        readySeen = true;
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString();
    });
    void exit.then((code) => {
      if (readySeen) return;
      clearTimeout(timer);
      reject(new Error(`watch exited before READY: ${code} ${out}\n${err}`));
    });
  });
  await ready;
  assert.equal(child.exitCode, null);
  assert.equal(child.killed, false);
  child.stdin.write('GO\n');
  let finishTimer: ReturnType<typeof setTimeout> | undefined;
  const status = await Promise.race([
    exit,
    new Promise<never>((_, reject) => {
      finishTimer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`watch finish timed out: ${out}\n${err}`));
      }, 10_000);
    }),
  ]).finally(() => {
    if (finishTimer) clearTimeout(finishTimer);
  });
  assert.equal(status, 0, err);
  assert.match(out, /READY/);
  assert.match(out, /DONE/);
});

test('dev-node without a toolchain exits 1 and does not download', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cct-dev-node-'));
  try {
    fs.mkdirSync(path.join(dir, 'scripts'));
    fs.copyFileSync(path.join(root, '.nvmrc'), path.join(dir, '.nvmrc'));
    if (process.platform === 'win32') {
      fs.copyFileSync(
        path.join(root, 'scripts', 'dev-node.ps1'),
        path.join(dir, 'scripts', 'dev-node.ps1'),
      );
    } else {
      fs.copyFileSync(
        path.join(root, 'scripts', 'dev-node.sh'),
        path.join(dir, 'scripts', 'dev-node.sh'),
      );
    }
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CCT_DEV_NODE_ISOLATE: '1',
      PATH:
        process.platform === 'win32'
          ? `${os.tmpdir()};${process.env.SystemRoot || 'C:\\Windows'}\\System32`
          : `${os.tmpdir()}:/usr/bin:/bin`,
      HOME: dir,
      USERPROFILE: dir,
    };
    delete env.NVM_DIR;
    delete env.NVM_HOME;
    const child = spawn(
      process.platform === 'win32' ? powershellExe : '/bin/sh',
      process.platform === 'win32'
        ? [
            '-NoProfile',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            path.join(dir, 'scripts', 'dev-node.ps1'),
            '--',
            'node',
            '-e',
            '0',
          ]
        : [path.join(dir, 'scripts', 'dev-node.sh'), '--', 'node', '-e', '0'],
      { cwd: dir, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const result = await new Promise<{
      status: number | null;
      out: string;
      err: string;
    }>((resolve, reject) => {
      let out = '';
      let err = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('missing-toolchain probe timed out'));
      }, 10_000);
      child.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        err += chunk.toString();
      });
      child.once('exit', (status) => {
        clearTimeout(timer);
        resolve({ status, out, err });
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    assert.equal(result.status, 1);
    assert.match(`${result.out}\n${result.err}`, /not on PATH|npm is missing/i);
    assert.equal(fs.existsSync(path.join(dir, '.tools')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
