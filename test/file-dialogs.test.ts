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
/** Current `stat` implementation for the stub. */
let statImpl: (uri: {
  scheme: string;
  fsPath?: string;
}) => Promise<{ type: number; size: number }>;
/** Current `readFile` implementation for the stub. */
let readImpl: (uri: { scheme: string }) => Promise<Uint8Array>;

/** Node module loader, used to intercept `require('vscode')`. */
const loader = Module as unknown as {
  _load(id: string, parent: unknown, isMain: boolean): unknown;
};
/** Original Node module loader. */
const original = loader._load;
loader._load = function (id, parent, isMain) {
  if (id !== 'vscode') return original.call(this, id, parent, isMain);
  return {
    FileType,
    Uri: {
      file(fsPath: string) {
        return { scheme: 'file', fsPath };
      },
    },
    workspace: {
      fs: {
        async stat(uri: { scheme: string; fsPath?: string }) {
          fsCalls.push({ method: 'stat', uri });
          return statImpl(uri);
        },
        async readFile(uri: { scheme: string }) {
          fsCalls.push({ method: 'readFile', uri });
          return readImpl(uri);
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
  test('import dialog defaults to a local file JSON picker', () => {
    const options = dialogs.importDialogOptions('/tmp/exports');
    assert.equal(options.defaultUri?.scheme, 'file');
    assert.equal(options.canSelectMany, false);
    assert.equal(options.canSelectFolders, false);
    assert.deepEqual(options.filters, { JSON: ['json'] });
  });

  test('a local file is read from disk without workspace.fs', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cct-dialog-'));
    const file = path.join(dir, 'export.json');
    await fs.writeFile(file, '{"ok":true}');
    fsCalls.length = 0;
    const value = await dialogs.readExportUri({
      scheme: 'file',
      fsPath: file,
    } as never);
    assert.deepEqual(value, { ok: true });
    assert.deepEqual(fsCalls, []);
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('a vscode-remote URI is read through the file provider', async () => {
    const uri = remoteUri();
    fsCalls.length = 0;
    statImpl = async () => ({ type: FileType.File, size: 12 });
    readImpl = async () => Buffer.from('{"remote":1}', 'utf8');
    const value = await dialogs.readExportUri(uri as never);
    assert.deepEqual(value, { remote: 1 });
    assert.deepEqual(
      fsCalls.map((row) => row.method),
      ['stat', 'readFile'],
    );
    assert.equal(fsCalls[0].uri, uri);
  });

  test('unsupported schemes, directories, and oversize stats are rejected', async () => {
    await assert.rejects(
      () => dialogs.readExportUri({ scheme: 'untitled' } as never),
      /this computer or the connected remote host/,
    );
    statImpl = async () => ({ type: FileType.Directory, size: 4 });
    readImpl = async () => {
      throw new Error('readFile must not run');
    };
    await assert.rejects(
      () => dialogs.readExportUri(remoteUri() as never),
      /no larger than 512 MiB/,
    );
    statImpl = async () => ({ type: FileType.Unknown, size: 4 });
    await assert.rejects(
      () => dialogs.readExportUri(remoteUri() as never),
      /no larger than 512 MiB/,
    );
    statImpl = async () => ({
      type: FileType.File,
      size: dialogs.MAX_REMOTE_EXPORT_BYTES + 1,
    });
    fsCalls.length = 0;
    await assert.rejects(() => dialogs.readExportUri(remoteUri() as never));
    assert.deepEqual(
      fsCalls.map((row) => row.method),
      ['stat'],
    );
  });

  test('a remote file that grew after stat is rejected', async () => {
    statImpl = async () => ({ type: FileType.File, size: 8 });
    readImpl = async () =>
      ({ byteLength: dialogs.MAX_REMOTE_EXPORT_BYTES + 1 }) as Uint8Array;
    await assert.rejects(
      () => dialogs.readExportUri(remoteUri() as never),
      /exceeds 512 MiB/,
    );
  });

  test('invalid UTF-8, malformed JSON, and provider errors stay operation errors', async () => {
    statImpl = async () => ({ type: FileType.File, size: 4 });
    readImpl = async () => Buffer.from([0xff, 0xfe, 0xfd, 0xfc]);
    await assert.rejects(() => dialogs.readExportUri(remoteUri() as never));
    readImpl = async () => Buffer.from('{', 'utf8');
    await assert.rejects(() => dialogs.readExportUri(remoteUri() as never));
    statImpl = async () => {
      throw Object.assign(new Error('ENOENT'), { code: 'FileNotFound' });
    };
    await assert.rejects(
      () => dialogs.readExportUri(remoteUri() as never),
      /ENOENT/,
    );
  });

  test('abort before and after remote IO does not parse JSON', async () => {
    const abort = () => {
      const c = new AbortController();
      c.abort();
      return c.signal;
    };
    await assert.rejects(
      () => dialogs.readExportUri(remoteUri() as never, abort()),
      (err: unknown) => (err as Error).name === 'AbortError',
    );
    statImpl = async () => ({ type: FileType.File, size: 12 });
    readImpl = async () => Buffer.from('{"ok":true}', 'utf8');
    const afterStat = new AbortController();
    const origStat = statImpl;
    statImpl = async (uri) => {
      const result = await origStat(uri);
      afterStat.abort();
      return result;
    };
    await assert.rejects(
      () => dialogs.readExportUri(remoteUri() as never, afterStat.signal),
      (err: unknown) => (err as Error).name === 'AbortError',
    );
    const afterRead = new AbortController();
    statImpl = async () => ({ type: FileType.File, size: 12 });
    readImpl = async () => {
      afterRead.abort();
      return Buffer.from('{"ok":true}', 'utf8');
    };
    await assert.rejects(
      () => dialogs.readExportUri(remoteUri() as never, afterRead.signal),
      (err: unknown) => (err as Error).name === 'AbortError',
    );
  });
});
