import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { EventEmitter } from 'node:events';

/** Minimal yauzl surface used to walk VSIX entries. */
interface ZipFile extends EventEmitter {
  /** Read the next zip entry. */
  readEntry(): void;
  /** Close the zip handle. */
  close(): void;
}

/** One zip member name as yauzl reports it. */
interface ZipEntry {
  /** Path inside the archive. */
  fileName: string;
}

/** Direct development dependency; keep the adapter local to this script. */
const yauzl = require('yauzl') as {
  /** Open a zip file and walk entries lazily. */
  open(
    /** Path of the VSIX zip. */
    file: string,
    options: {
      /** Walk entries one at a time instead of buffering the central directory. */
      lazyEntries: boolean;
    },
    /** Called once the zip handle is open or the open failed. */
    callback: (error: Error | null, zip?: ZipFile) => void,
  ): void;
};

/** List files inside a VSIX zip without shelling out to unzip. */
function inventory(file: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) {
        reject(error || new Error('Unable to open VSIX'));
        return;
      }
      const names: string[] = [];
      zip.on('error', (error) => {
        zip.close();
        reject(error);
      });
      zip.on('end', () => resolve(names));
      zip.on('entry', (entry: ZipEntry) => {
        names.push(entry.fileName);
        zip.readEntry();
      });
      zip.readEntry();
    });
  });
}

/** Reject development paths and confirm every `src` module compiled into the VSIX. */
async function main(): Promise<void> {
  const root = path.resolve(__dirname, '..');
  const vsix = path.join(root, 'dist', 'cursor-chat-transit.vsix');
  if (!fs.existsSync(vsix)) throw new Error('VSIX not found');
  const names = new Set(await inventory(vsix));
  const foldedNames = new Set([...names].map((name) => name.toLowerCase()));
  for (const name of names) {
    const parts = name.split('/');
    if (
      parts.some((part) =>
        ['.git', 'tmp', 'test', '.dev', 'src', 'node_modules'].includes(part),
      ) ||
      /state\.vscdb(?:-|$)|\.cursor-chat\.json$/.test(name)
    ) {
      throw new Error(`VSIX contains forbidden path: ${name}`);
    }
  }
  const modules = fs
    .readdirSync(path.join(root, 'src'))
    .filter((name) => name.endsWith('.ts'))
    .map((name) => `out/${name.replace(/\.ts$/, '.js')}`);
  for (const required of [
    ...modules,
    'package.json',
    'README.md',
    'LICENSE.txt',
    'resources/marketplace.png',
    'resources/icons/activity-bar.svg',
    'resources/sidebar.html',
    'resources/sidebar.css',
    'resources/sidebar-client.js',
  ]) {
    if (!foldedNames.has(`extension/${required}`.toLowerCase()))
      throw new Error(`VSIX missing ${required}`);
  }
  console.log('modules', modules.length);
  console.log(
    'sha256',
    crypto.createHash('sha256').update(fs.readFileSync(vsix)).digest('hex'),
  );
  console.log('size', fs.statSync(vsix).size);
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
