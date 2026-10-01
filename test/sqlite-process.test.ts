import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { runSqlite } from '../src/sqlite-process';
import { SqliteError } from '../src/types';

/** Skip POSIX fake-process tests on Windows; native CLI coverage is still required. */
const skip =
  process.platform === 'win32'
    ? 'POSIX fake executable; real Windows CLI tests still required'
    : false;

/** POSIX fake sqlite3 that echoes stdin, fails, or waits. */
async function fixture(t: {
  /** Register cleanup that deletes the throwaway directory. */
  after: (fn: () => Promise<void>) => void;
}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cct-transport-test-'));

  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const executable = path.join(dir, 'fake-sqlite');

  await fs.writeFile(
    executable,
    `#!/usr/bin/env node
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', x => input += x);
process.stdin.on('end', () => {
  if (input === 'wait') { setInterval(() => {}, 1000); return; }
  if (input === 'fail') { process.stderr.write('fixture error'); process.exitCode = 2; return; }
  process.stdout.write(input);
});
`,
    { mode: 0o700 },
  );

  const initFile = path.join(dir, 'empty-init');

  await fs.writeFile(initFile, '');
  let result = '';

  const output = new Writable({
    /** Collect sqlite stdout into the fixture result. */
    write(chunk, _encoding, callback) {
      result += chunk.toString();
      callback();
    },
  });

  return {
    options: {
      executable,
      database: path.join(dir, 'test.db'),
      initFile,
      output,
      input: 'hello',
      timeoutMs: 3000,
    },
    getResult: () => result,
  };
}

test(
  'transport pumps data and waits for successful process exit',
  { skip },
  async (t) => {
    const f = await fixture(t);

    await runSqlite(f.options);
    assert.equal(f.getResult(), 'hello');
  },
);

test(
  'transport rejects nonzero child exit with bounded stderr',
  { skip },
  async (t) => {
    const f = await fixture(t);

    await assert.rejects(
      runSqlite({ ...f.options, input: 'fail' }),
      (error: unknown) =>
        error instanceof SqliteError &&
        error.code === 2 &&
        error.stderr === 'fixture error',
    );
  },
);

test('transport cancellation settles after child exit', { skip }, async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();

  const pending = runSqlite({
    ...f.options,
    input: 'wait',
    signal: controller.signal,
  });

  controller.abort(new Error('fixture cancellation'));
  await assert.rejects(pending, /fixture cancellation/);
});

test('transport deadline aborts streams and child', { skip }, async (t) => {
  const f = await fixture(t);

  await assert.rejects(
    runSqlite({ ...f.options, input: 'wait', timeoutMs: 100 }),
    /timed out/,
  );
});

test('transport rejects an output sink failure', { skip }, async (t) => {
  const f = await fixture(t);

  const output = new Writable({
    /** Fail the stream as if the destination disk were full. */
    write(_chunk, _encoding, callback) {
      callback(new Error('fixture disk full'));
    },
  });

  await assert.rejects(
    runSqlite({ ...f.options, output }),
    /fixture disk full/,
  );
});

test('transport reports executable not found', { skip }, async (t) => {
  const f = await fixture(t);

  await assert.rejects(
    runSqlite({ ...f.options, executable: '/does-not-exist/cct-sqlite' }),
    (error: unknown) =>
      error instanceof Error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT',
  );
});
