import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { encodePlan, writePlanFile } from '../src/plans';
import { encodeAttachment, writeAttachmentFile } from '../src/dependencies';
import { writeFileNoClobber } from '../src/resource-files';
import { TransferError } from '../src/types';
import type { WorkspaceEntry } from '../src/types';

/** Bytes written as a competing destination file. */
const bytes = Buffer.from('expected resource');
/** Attachment UUID used in image install tests. */
const id = '22222222-2222-4222-8222-222222222222';

for (const kind of ['plan', 'image'] as const) {
  for (const outcome of ['same', 'different', 'permission'] as const) {
    test(`${kind} concurrent install: ${outcome}; no overwrite or staging leak`, async (t) => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'transit-resource-'));

      t.after(() => fs.rm(dir, { recursive: true, force: true }));
      const root = path.join(dir, kind === 'plan' ? 'plans' : 'images');

      const dest = path.join(
        root,
        kind === 'plan' ? 'demo.plan.md' : `${id}.png`,
      );

      const workspace: WorkspaceEntry = {
        storageRoot: dir,
        storageId: 'test',
        key: 'test',
        mtime: 0,
        workspaceDbPath: path.join(dir, 'state.vscdb'),
        globalDbPath: path.join(dir, 'global.vscdb'),
      };

      const install = () =>
        kind === 'plan'
          ? writePlanFile(root, encodePlan('demo.plan.md', bytes))
          : writeAttachmentFile(workspace, encodeAttachment(id, bytes, 'png'));

      const original = fs.link;
      let reached = false;

      fs.link = async (from, to) => {
        if (to === dest) {
          reached = true;
          if (outcome === 'permission')
            throw Object.assign(new Error('denied'), { code: 'EACCES' });

          await fs.writeFile(
            dest,
            outcome === 'same' ? bytes : 'concurrent content',
          );
        }

        return original(from, to);
      };

      try {
        if (outcome === 'same') await install();
        else
          await assert.rejects(install(), (error: unknown) =>
            outcome === 'permission'
              ? (error as NodeJS.ErrnoException).code === 'EACCES'
              : error instanceof TransferError &&
                error.code === 'RESOURCE_CONFLICT',
          );
      } finally {
        fs.link = original;
      }

      assert.equal(reached, true);
      const names = await fs.readdir(root);

      assert.equal(
        names.some((name) => name.endsWith('.partial')),
        false,
      );

      if (outcome === 'permission') assert.deepEqual(names, []);
      else
        assert.deepEqual(
          await fs.readFile(dest),
          outcome === 'same' ? bytes : Buffer.from('concurrent content'),
        );
    });
  }
}

test('shared install accepts a trailing separator and rejects an escaping path', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'transit-path-'));

  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'plans') + path.sep;
  const dest = path.join(root, 'demo.plan.md');

  await writeFileNoClobber(root, dest, bytes, 'Conflict');
  assert.deepEqual(await fs.readFile(dest), bytes);

  await assert.rejects(
    writeFileNoClobber(root, path.join(dir, 'escape'), bytes, 'Conflict'),
    (error: unknown) =>
      error instanceof TransferError && error.code === 'INVALID_RESOURCE',
  );

  await assert.rejects(fs.stat(path.join(dir, 'escape')), { code: 'ENOENT' });
});
