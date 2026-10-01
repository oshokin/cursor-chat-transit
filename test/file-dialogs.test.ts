import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** VS Code FileType values used by the file-dialogs stub. */
const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 };
/** workspace.fs calls recorded by the stub. */
const fsCalls: Array<{ method: string; uri: { scheme: string } }> = [];

/** Current `copy` implementation for the stub. */
let copiedTo = '';

/** Replacement for `workspace.fs.copy` in the vscode stub. */
let copyImpl: (uri: { scheme: string }) => Promise<void> = async () =>
  undefined;

/** Node module loader, used to intercept `require('vscode')`. */
const loader = Module as unknown as {
  /** Node's internal module loader, replaced for the duration of the test. */
  _load(id: string, parent: unknown, isMain: boolean): unknown;
};

/** Original Node module loader. */
const original = loader._load;

loader._load = function (id, parent, isMain) {
  if (id !== 'vscode') return original.call(this, id, parent, isMain);

  return {
    FileType,
    Uri: {
      /** Build a file URI from a filesystem path. */
      file(fsPath: string) {
        return { scheme: 'file', fsPath };
      },
    },
    workspace: {
      fs: {
        /** Record a remote copy. The extension does not read the bytes itself. */
        async copy(uri: { scheme: string }, target: { fsPath: string }) {
          copiedTo = target.fsPath;
          fsCalls.push({ method: 'copy', uri });
          await copyImpl(uri);
        },
      },
    },
  };
};

/** `file-dialogs` loaded against the vscode stub. */
let dialogs: typeof import('../src/file-dialogs');

try {
  dialogs = require('../src/file-dialogs') as typeof dialogs;
} finally {
  loader._load = original;
}

/** Remote URI whose `fsPath` getter fails if the reader treats it as local. */
function remoteUri(): {
  /** Always `vscode-remote` in this stub. */
  scheme: string;
  /** Throws if a caller treats a remote URI as a local path. */
  readonly fsPath: string;
} {
  return {
    scheme: 'vscode-remote',
    /** Throws if a caller treats a remote URI as a local path. */
    get fsPath(): string {
      throw new Error('fsPath must not be used for a remote URI');
    },
  };
}

describe('file dialogs', { concurrency: false }, () => {
  test('import dialog defaults to a local zip picker', () => {
    const options = dialogs.importDialogOptions('/tmp/exports');

    assert.equal(options.defaultUri?.scheme, 'file');
    assert.equal(options.canSelectMany, false);
    assert.equal(options.canSelectFolders, false);
    assert.deepEqual(options.filters, { 'Cursor chat export': ['zip'] });
  });

  test('a local file path is returned without workspace.fs', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cct-dialog-'));
    const file = path.join(dir, 'export.cursor-chat.zip');

    await fs.writeFile(file, 'zip');
    fsCalls.length = 0;

    const value = await dialogs.localBundlePath({
      scheme: 'file',
      fsPath: file,
    } as never);

    assert.equal(value, file);
    assert.deepEqual(fsCalls, []);
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('a vscode-remote URI is copied, not buffered', async () => {
    const uri = remoteUri();

    fsCalls.length = 0;
    copyImpl = async () => undefined;
    const value = await dialogs.localBundlePath(uri as never);

    assert.match(value, /import\.cursor-chat\.zip$/);

    assert.deepEqual(
      fsCalls.map((row) => row.method),
      ['copy'],
    );

    assert.equal(fsCalls[0].uri, uri);
    await fs.rm(path.dirname(value), { recursive: true, force: true });
  });

  test('unsupported schemes are rejected before copy', async () => {
    await assert.rejects(
      () => dialogs.localBundlePath({ scheme: 'untitled' } as never),
      /this computer or the connected remote host/,
    );
  });

  test('provider errors stay operation errors', async () => {
    copyImpl = async () => {
      throw Object.assign(new Error('ENOENT'), { code: 'FileNotFound' });
    };

    await assert.rejects(
      () => dialogs.localBundlePath(remoteUri() as never),
      /ENOENT/,
    );

    await assert.rejects(() => fs.stat(path.dirname(copiedTo)), {
      code: 'ENOENT',
    });
  });

  test('abort before copy does not touch the provider', async () => {
    const controller = new AbortController();

    controller.abort();
    fsCalls.length = 0;

    await assert.rejects(
      () => dialogs.localBundlePath(remoteUri() as never, controller.signal),
      (err: unknown) => (err as Error).name === 'AbortError',
    );

    assert.deepEqual(fsCalls, []);
  });
});

void FileType;
