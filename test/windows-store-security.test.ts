import assert from 'node:assert/strict';
import test from 'node:test';
import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  provisionWindowsVisualizationScope,
  verifyWindowsStoreSecurity,
} from '../src/windows-store-security';

const user = 'S-1-5-21-1-2-3-1001';

function security() {
  return {
    owner: user,
    reparse: false,
    protected: true,
    rules: [user, 'S-1-5-18', 'S-1-5-32-544'].map((sid) => ({
      sid,
      inherited: false,
      allow: true,
      rights: 2032127,
      inheritance: 3,
      propagation: 0,
    })),
  };
}

test('Windows ACL verification requires exact private inheritable SID grants and owner', () => {
  verifyWindowsStoreSecurity(security(), user);
  for (const mutation of [
    { owner: 'S-1-5-18' },
    { reparse: true },
    { protected: false },
    { rules: [] },
    {
      rules: [...security().rules, { ...security().rules[0], sid: 'S-1-1-0' }],
    },
    ...['inherited', 'allow', 'rights', 'inheritance', 'propagation'].map(
      (key) => ({
        rules: security().rules.map((rule, i) =>
          i
            ? rule
            : {
                ...rule,
                [key]:
                  key === 'inherited' ? true : key === 'propagation' ? 1 : 0,
              },
        ),
      }),
    ),
  ])
    assert.throws(
      () => verifyWindowsStoreSecurity({ ...security(), ...mutation }, user),
      /Unsafe/,
    );
});

for (const fault of [
  'success',
  'timeout',
  'mismatch',
  'reparse',
  'foreign',
  'symlink',
] as const) {
  test(`Windows provisioning mocked platform: ${fault}`, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'windows-acl-'));
    const base = path.join(root, 'store');
    const scope = path.join(base, 'files');
    const previous = process.env.SystemRoot;

    process.env.SystemRoot = 'C:\\Windows';
    let grants = 0;

    t.mock.method(childProcess, 'execFile', (...args: unknown[]) => {
      const executable = args[0] as string;
      const argv = args[1] as string[];
      const options = args[2] as { shell: boolean; timeout: number };

      const callback = args[3] as (
        error: Error | null,
        stdout?: string,
      ) => void;

      assert.equal(options.shell, false);
      assert.equal(options.timeout, 10000);

      if (executable.endsWith('icacls.exe')) {
        grants++;
        assert.deepEqual(argv.slice(1, 3), ['/inheritance:r', '/grant:r']);

        return callback(
          fault === 'timeout'
            ? Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })
            : null,
          '',
        );
      }

      const script = Buffer.from(argv.at(-1)!, 'base64').toString('utf16le');

      if (!script.includes('Get-Acl')) return callback(null, user);
      const acl = security();

      if (fault === 'mismatch' && grants) acl.protected = false;
      if (fault === 'reparse') acl.reparse = true;
      if (fault === 'foreign') acl.owner = 'S-1-5-18';
      callback(null, JSON.stringify(acl));
    });

    try {
      if (fault === 'foreign') await fs.mkdir(base);
      if (fault === 'symlink') await fs.symlink(root, base, 'dir');

      if (fault === 'success') {
        await provisionWindowsVisualizationScope(scope, base);
        assert.equal(grants, 2);
        await provisionWindowsVisualizationScope(scope, base);
        assert.equal(grants, 2, 'existing directories are never repaired');
      } else {
        await assert.rejects(provisionWindowsVisualizationScope(scope, base));
        if (fault === 'timeout' || fault === 'mismatch')
          await assert.rejects(fs.lstat(base), { code: 'ENOENT' });
        if (fault === 'foreign' || fault === 'reparse' || fault === 'symlink')
          assert.equal(grants, 0);
      }
    } finally {
      if (previous === undefined) delete process.env.SystemRoot;
      else process.env.SystemRoot = previous;
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}
