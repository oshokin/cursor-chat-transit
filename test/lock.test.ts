import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { acquireLock, clearStaleLock } from '../src/lock';
import { TransferError } from '../src/types';

/** A PID that is not running on this host. */
function deadPid(): number {
  const pid = 2147483647;

  try {
    process.kill(pid, 0);

    throw new Error('Fixture PID is alive');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
  }

  return pid;
}

/** Run `fn` with a throwaway lock directory and always delete it afterwards. */
async function withLockDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cct-lock-'));

  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('an unreadable lock file is not stolen by a second process', async () => {
  await withLockDir(async (dir) => {
    await fs.writeFile(path.join(dir, 'transfer.lock'), '{not-json');

    await assert.rejects(
      () => acquireLock(dir, 'transfer'),
      (err: unknown) =>
        err instanceof TransferError && err.code === 'LOCK_RECOVERY_REQUIRED',
    );

    await fs.writeFile(path.join(dir, 'other.lock'), '');

    await assert.rejects(
      () => acquireLock(dir, 'other'),
      (err: unknown) =>
        err instanceof TransferError && err.code === 'LOCK_RECOVERY_REQUIRED',
    );

    assert.equal(
      await fs.readFile(path.join(dir, 'transfer.lock'), 'utf8'),
      '{not-json',
    );
  });
});

test('a held lock blocks a second acquirer', async () => {
  await withLockDir(async (dir) => {
    const first = await acquireLock(dir, 'transfer');

    try {
      await assert.rejects(
        () => acquireLock(dir, 'transfer'),
        (err: unknown) => err instanceof TransferError && err.code === 'LOCKED',
      );
    } finally {
      await first.release();
    }
  });
});

test('two concurrent acquires of a free lock yield exactly one owner', async () => {
  await withLockDir(async (dir) => {
    for (let attempt = 0; attempt < 40; attempt++) {
      const results = await Promise.allSettled([
        acquireLock(dir, 'transfer'),
        acquireLock(dir, 'transfer'),
      ]);

      const owners = results.filter((row) => row.status === 'fulfilled');
      const blocked = results.filter((row) => row.status === 'rejected');

      assert.equal(owners.length, 1);
      assert.equal(blocked.length, 1);

      if (blocked[0].status === 'rejected') {
        assert.equal((blocked[0].reason as TransferError).code, 'LOCKED');
      }

      if (owners[0].status === 'fulfilled') await owners[0].value.release();
    }
  });
});

test('a live lock, empty file, and invalid pid are not stolen', async () => {
  await withLockDir(async (dir) => {
    const live = await acquireLock(dir, 'live');

    await assert.rejects(
      () => acquireLock(dir, 'live'),
      (err: unknown) => err instanceof TransferError && err.code === 'LOCKED',
    );

    await fs.writeFile(path.join(dir, 'empty.lock'), '');

    await assert.rejects(
      () => acquireLock(dir, 'empty'),
      (err: unknown) =>
        err instanceof TransferError && err.code === 'LOCK_RECOVERY_REQUIRED',
    );

    await fs.writeFile(
      path.join(dir, 'badpid.lock'),
      JSON.stringify({ pid: 'nope', token: 'x' }),
    );

    await assert.rejects(
      () => acquireLock(dir, 'badpid'),
      (err: unknown) =>
        err instanceof TransferError && err.code === 'LOCK_RECOVERY_REQUIRED',
    );

    await live.release();
  });
});

test('two stale-lock acquires do not start writing', async () => {
  await withLockDir(async (dir) => {
    const file = path.join(dir, 'transfer.lock');

    await fs.writeFile(file, JSON.stringify({ pid: deadPid(), startedAt: 1 }));

    const results = await Promise.allSettled([
      acquireLock(dir, 'transfer'),
      acquireLock(dir, 'transfer'),
    ]);

    assert.deepEqual(
      results.map((row) => row.status),
      ['rejected', 'rejected'],
    );

    for (const row of results) {
      assert.equal(row.status, 'rejected');

      if (row.status === 'rejected') {
        const err = row.reason as TransferError;

        assert.equal(err.code, 'LOCK_RECOVERY_REQUIRED');
        assert.match(err.message, /did not finish/);
        assert.match(err.message, /transfer\.lock/);
      }
    }

    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).pid, deadPid());
  });
});

test('a repeated release does not delete the next owner lock', async () => {
  await withLockDir(async (dir) => {
    const first = await acquireLock(dir, 'transfer');

    await first.release();
    const second = await acquireLock(dir, 'transfer');

    await first.release();

    await assert.rejects(
      () => acquireLock(dir, 'transfer'),
      (err: unknown) => err instanceof TransferError && err.code === 'LOCKED',
    );

    const payload = JSON.parse(
      await fs.readFile(path.join(dir, 'transfer.lock'), 'utf8'),
    ) as { token: string };

    assert.equal(typeof payload.token, 'string');
    await second.release();
  });
});

test('release does not delete a lock whose owner token differs', async () => {
  await withLockDir(async (dir) => {
    const first = await acquireLock(dir, 'transfer');

    await fs.writeFile(
      path.join(dir, 'transfer.lock'),
      JSON.stringify({ pid: process.pid, token: 'other-owner', startedAt: 1 }),
    );

    await first.release();

    assert.equal(
      JSON.parse(await fs.readFile(path.join(dir, 'transfer.lock'), 'utf8'))
        .token,
      'other-owner',
    );
  });
});

test('a lock create failure is not reported as LOCKED', async () => {
  await withLockDir(async (dir) => {
    const blocked = path.join(dir, 'blocked');

    await fs.writeFile(blocked, 'not-a-directory');

    await assert.rejects(
      () => acquireLock(blocked, 'transfer'),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.notEqual((err as TransferError).code, 'LOCKED');
        assert.notEqual((err as TransferError).code, 'LOCK_RECOVERY_REQUIRED');

        return true;
      },
    );
  });
});

test(
  'two OS processes: exactly one acquires a free lock',
  { timeout: 15_000 },
  async () => {
    await withLockDir(async (dir) => {
      const holderSrc = `
import { acquireLock, clearStaleLock } from ${JSON.stringify(pathToFileURL(path.resolve('src/lock.ts')).href)};
const dir = process.argv[1];
const handle = await acquireLock(dir, 'transfer');
process.stdout.write('ACQUIRED\\n');
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('hold timeout')), 5000);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    if (String(chunk).includes('GO')) {
      clearTimeout(timer);
      resolve(undefined);
    }
  });
});
await handle.release();
`;

      const challengerSrc = `
import { acquireLock, clearStaleLock } from ${JSON.stringify(pathToFileURL(path.resolve('src/lock.ts')).href)};
try {
  await acquireLock(process.argv[1], 'transfer');
  process.stdout.write('ACQUIRED\\n');
  process.exitCode = 0;
} catch (err) {
  const code =
    err && typeof err === 'object' && 'code' in err
      ? String(err.code || 'ERR')
      : 'ERR';
  process.stdout.write(code + '\\n');
  process.exitCode = 2;
}
`;

      const spawnSrc = (source: string, stdin: 'pipe' | 'ignore') => {
        const child = spawn(
          process.execPath,
          ['--import', 'tsx', '-e', source, dir],
          { stdio: [stdin, 'pipe', 'pipe'] },
        );

        child.on('error', () => undefined);

        return child;
      };

      const attach = (child: ReturnType<typeof spawn>) => {
        let out = '';
        let err = '';
        const waiters: Array<{ needle: string; resolve: () => void }> = [];

        const onData = (chunk: Buffer) => {
          out += chunk.toString();

          for (const waiter of [...waiters]) {
            if (out.includes(waiter.needle)) {
              waiters.splice(waiters.indexOf(waiter), 1);
              waiter.resolve();
            }
          }
        };

        child.stdout?.on('data', onData);

        child.stderr?.on('data', (chunk: Buffer) => {
          err += chunk.toString();
        });

        return {
          child,
          /** Stdout collected so far from the fixture child. */
          get out() {
            return out;
          },
          /** Stderr collected so far from the fixture child. */
          get err() {
            return err;
          },
          /** Resolve when the child prints the expected text. */
          waitFor(needle: string, ms: number) {
            if (out.includes(needle)) return Promise.resolve();

            return new Promise<void>((resolve, reject) => {
              const timer = setTimeout(() => {
                reject(
                  new Error(`timeout waiting for ${needle}: ${out}\n${err}`),
                );
              }, ms);

              waiters.push({
                needle,
                resolve: () => {
                  clearTimeout(timer);
                  resolve();
                },
              });
            });
          },
          exit: new Promise<number | null>((resolve, reject) => {
            const timer = setTimeout(() => {
              reject(new Error(`lock child timed out: ${out}\n${err}`));
            }, 8_000);

            child.once('error', (error) => {
              clearTimeout(timer);
              reject(error);
            });

            child.once('exit', (status) => {
              clearTimeout(timer);
              resolve(status);
            });
          }),
        };
      };

      const a = spawnSrc(holderSrc, 'pipe');
      const held = attach(a);

      try {
        await held.waitFor('ACQUIRED', 8_000);
        assert.equal(a.exitCode, null);
        const b = spawnSrc(challengerSrc, 'ignore');
        const blocked = attach(b);
        const bStatus = await blocked.exit;

        assert.match(
          blocked.out,
          /LOCKED/,
          `${blocked.out}|${blocked.err}|${held.out}|${held.err}`,
        );

        assert.equal(
          bStatus,
          2,
          `${blocked.out}|${blocked.err}|${held.out}|${held.err}`,
        );

        a.stdin?.write('GO\n');
        a.stdin?.end();
        assert.equal(await held.exit, 0, `${held.out}|${held.err}`);
        assert.match(held.out, /ACQUIRED/);
      } finally {
        a.stdin?.end();
      }
    });
  },
);

test('explicit stale-lock recovery removes the same dead owner and allows retry', async () => {
  await withLockDir(async (dir) => {
    const expected = {
      lockPath: path.join(dir, 'transfer.lock'),
      pid: deadPid(),
      token: 'a'.repeat(32),
    };

    await fs.writeFile(expected.lockPath, JSON.stringify(expected));

    await assert.rejects(
      () => acquireLock(dir, 'transfer'),
      (error) => {
        assert.deepEqual(
          JSON.parse((error as TransferError).detail!),
          expected,
        );

        return true;
      },
    );

    await clearStaleLock(expected);
    const next = await acquireLock(dir, 'transfer');

    await next.release();
  });
});

test('stale-lock recovery refuses live owners, changed tokens and symlinks', async () => {
  await withLockDir(async (dir) => {
    const expected = {
      lockPath: path.join(dir, 'transfer.lock'),
      pid: process.pid,
      token: 'a'.repeat(32),
    };

    await fs.writeFile(expected.lockPath, JSON.stringify(expected));
    await assert.rejects(() => clearStaleLock(expected), /still running/);
    expected.pid = deadPid();

    await fs.writeFile(
      expected.lockPath,
      JSON.stringify({ ...expected, token: 'b'.repeat(32) }),
    );

    await assert.rejects(() => clearStaleLock(expected), /ownership changed/);
    const target = path.join(dir, 'keep');

    await fs.writeFile(target, JSON.stringify(expected));
    await fs.unlink(expected.lockPath);
    await fs.symlink(target, expected.lockPath);
    await assert.rejects(() => clearStaleLock(expected), /regular lock file/);
    assert.deepEqual(JSON.parse(await fs.readFile(target, 'utf8')), expected);
  });
});
