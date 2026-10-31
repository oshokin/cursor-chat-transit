import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import yauzl from 'yauzl';

/** Deadline for the isolated packaged-native smoke process. */
const nativePackageSmokeTimeoutMs = 20_000;

/** Validate the shipped native runtime in an isolated installation with no CLI or node_modules. */
async function main(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cct-packaged-native-'));
  const artifact = path.resolve(__dirname, '../dist/cursor-chat-transit.vsix');

  try {
    await new Promise<void>((resolve, reject) =>
      yauzl.open(artifact, { lazyEntries: true }, (error, zip) => {
        if (error || !zip) {
          reject(error || new Error('No VSIX'));

          return;
        }

        zip.on('error', reject);
        zip.on('end', resolve);

        zip.on('entry', (entry: yauzl.Entry) => {
          if (
            !/^extension\/(out|vendor)\//.test(entry.fileName) ||
            entry.fileName.endsWith('/')
          ) {
            zip.readEntry();

            return;
          }

          const target = path.resolve(root, entry.fileName);

          if (!target.startsWith(root + path.sep)) {
            zip.close();
            reject(new Error('Invalid package path'));

            return;
          }

          zip.openReadStream(entry, (streamError, stream) => {
            if (streamError || !stream) {
              reject(streamError || new Error('Missing package bytes'));

              return;
            }

            void fs
              .mkdir(path.dirname(target), { recursive: true })
              .then(() => pipeline(stream, createWriteStream(target)))
              .then(() => zip.readEntry(), reject);
          });
        });

        zip.readEntry();
      }),
    );

    const code = `const path=require('node:path');
const {SqliteSession}=require(path.join(process.argv[1],'extension/out/sqlite-session.js'));
const {nativeSqliteVersion}=require(path.join(process.argv[1],'extension/out/sqlite-native.js'));
(async()=>{const s=await SqliteSession.open({database:path.join(process.argv[1],'smoke.sqlite'),executable:'/missing/sqlite3'});try{
await s.exec('CREATE TABLE t(value);');await s.exec('INSERT INTO t VALUES (?);',[Buffer.from([0,255,128])]);
await s.rows('SELECT value FROM t;',[],row=>{if(!row[0].equals(Buffer.from([0,255,128])))throw new Error('Packaged blob mismatch');});
console.log(JSON.stringify({sqlite:nativeSqliteVersion(),napi:process.versions.napi,offlineNative:true}));
}finally{await s.close();}})().catch(error=>{console.error(error);process.exitCode=1;});`;

    const result = await promisify(execFile)(
      process.execPath,
      ['-e', code, root],
      {
        cwd: root,
        env: { ...process.env, PATH: '', NODE_PATH: '' },
        timeout: nativePackageSmokeTimeoutMs,
      },
    );

    console.log(result.stdout.trim());
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
