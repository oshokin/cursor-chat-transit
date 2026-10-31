import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { SqliteSupervisor } from '../src/sqlite-supervisor';
import { SqliteSession } from '../src/sqlite-session';

function fake() {
  let kills = 0;

  const child = Object.assign(new EventEmitter(), {
    kill: () => {
      kills++;

      return true;
    },
  });

  const supervisor = new SqliteSupervisor(child as unknown as ChildProcess);

  return { supervisor, kills: () => kills };
}

test('parent deadline kills a worker without executing its event loop', async () => {
  const { supervisor, kills } = fake();

  supervisor.observe({ type: 'sqlite-start', requestId: 1, timeoutMs: 10 });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(kills(), 1);

  assert.equal(
    (supervisor.reason() as NodeJS.ErrnoException).code,
    'SQLITE_TIMEOUT',
  );

  supervisor.dispose();
});

test('completed SQL cancels the external deadline', async () => {
  const { supervisor, kills } = fake();

  supervisor.observe({ type: 'sqlite-start', requestId: 1, timeoutMs: 10 });
  supervisor.observe({ type: 'sqlite-end', requestId: 1, timeoutMs: 10 });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(kills(), 0);
  supervisor.dispose();
});

test('invalid watchdog packets never schedule a process kill', async () => {
  const { supervisor, kills } = fake();

  for (const timeoutMs of [-1, 0, Number.NaN, Number.POSITIVE_INFINITY])
    supervisor.observe({ type: 'sqlite-start', requestId: 1, timeoutMs });
  assert.equal(supervisor.observe({}), false);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(kills(), 0);
  supervisor.dispose();
});

test('cancellation grace is idempotent and disposal cancels it', async () => {
  const { supervisor, kills } = fake();

  supervisor.cancel(10);
  supervisor.cancel(10);
  supervisor.dispose();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(kills(), 0);
});

test(
  'external watchdog terminates real synchronous native SQL and rolls back its writer',
  { timeout: 10000 },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cct-real-watchdog-'));
    const database = path.join(root, 'test.sqlite');
    const seed = await SqliteSession.open({ database });

    await seed.exec('CREATE TABLE t(value);');
    await seed.close();

    const child = fork(
      path.resolve('test/fixtures/native-watchdog.ts'),
      [database],
      {
        execArgv: ['--import', 'tsx'],
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      },
    );

    child.stderr?.resume();
    const supervisor = new SqliteSupervisor(child);

    t.after(async () => {
      supervisor.dispose();
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGKILL');
      await fs.rm(root, { recursive: true, force: true });
    });

    child.on('message', (message) =>
      supervisor.observe(message as Parameters<SqliteSupervisor['observe']>[0]),
    );

    await new Promise<void>((resolve, reject) => {
      child.once('close', () => resolve());
      child.once('error', reject);
    });

    assert.equal(
      (supervisor.reason() as NodeJS.ErrnoException).code,
      'SQLITE_TIMEOUT',
    );

    const verify = await SqliteSession.open({ database, busyTimeoutMs: 0 });

    try {
      assert.equal((await verify.exec('SELECT count(*) FROM t;')).trim(), '0');

      await verify.exec(
        "BEGIN IMMEDIATE; INSERT INTO t VALUES('next'); COMMIT;",
      );
    } finally {
      await verify.close();
    }
  },
);

test(
  'loss of the supervising host stops a native writer even while its event loop is blocked',
  { timeout: 10000 },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cct-orphan-writer-'));
    const database = path.join(root, 'test.sqlite');
    const seed = await SqliteSession.open({ database });

    await seed.exec('CREATE TABLE t(value);');
    await seed.close();

    const carrier = fork(
      path.resolve('test/fixtures/orphan-parent.ts'),
      [database],
      {
        execArgv: ['--import', 'tsx'],
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      },
    );

    t.after(async () => {
      if (carrier.exitCode === null) carrier.kill('SIGKILL');
      await fs.rm(root, { recursive: true, force: true });
    });

    let orphaned = false;

    carrier.on('message', () => {
      orphaned = true;
    });

    await new Promise<void>((resolve, reject) => {
      carrier.once('close', () => resolve());
      carrier.once('error', reject);
    });

    assert.equal(orphaned, true);
    let checked = false;

    for (let attempt = 0; attempt < 30 && !checked; attempt++) {
      const verify = await SqliteSession.open({ database, busyTimeoutMs: 0 });

      try {
        await verify.exec('BEGIN IMMEDIATE;');

        assert.equal(
          (await verify.exec('SELECT count(*) FROM t;')).trim(),
          '0',
        );

        await verify.exec("INSERT INTO t VALUES('surviving writer'); COMMIT;");
        checked = true;
      } catch (error) {
        if (!/locked|busy/i.test(String(error))) throw error;
      } finally {
        await verify.close();
      }

      if (!checked) await new Promise((resolve) => setTimeout(resolve, 50));
    }

    assert.equal(
      checked,
      true,
      'orphan watchdog must release the native writer',
    );
  },
);
