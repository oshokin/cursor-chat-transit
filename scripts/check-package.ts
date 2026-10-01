import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { EventEmitter } from 'node:events';
import { changelogSection } from './changelog-section';
import { stableVersion } from './stable-version';

/** Extension id and publisher that must stay in the VSIX identity. */
const EXTENSION_ID = 'cursor-chat-transit';
/** Marketplace publisher. A rename is a different extension. */
const PUBLISHER = 'oshokin';
/** Changelog in the repository. Keep a Changelog, GitHub, and release-it use this name. */
const CHANGELOG_FILE = 'CHANGELOG.md';
/** Changelog path inside the VSIX. vsce always rewrites the repository file to this. */
const PACKAGED_CHANGELOG = 'extension/changelog.md';

/** One zip member as yauzl reports it. */
interface ZipEntry {
  /** Path inside the archive. */
  fileName: string;
}

/** Readable stream of one zip member. */
interface ZipStream extends EventEmitter {
  /** File bytes. */
  on(event: 'data', listener: (chunk: Buffer) => void): this;
  /** The member has been read. */
  on(event: 'end', listener: () => void): this;
  /** The member could not be read. */
  on(event: 'error', listener: (error: Error) => void): this;
}

/** Minimal yauzl surface used to walk VSIX entries. */
interface ZipFile extends EventEmitter {
  /** Read the next zip entry. */
  readEntry(): void;
  /** Close the zip handle. */
  close(): void;
  /** Open one member. Call `readEntry` again when the stream ends. */
  openReadStream(
    entry: ZipEntry,
    callback: (error: Error | null, stream?: ZipStream) => void,
  ): void;
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

/** Names plus the text of the identity files inside a VSIX. */
interface VsixWalk {
  /** Every member path. */
  names: string[];
  /** Selected member contents, keyed by the zip path in lowercase. */
  files: Map<string, string>;
}

/** Read one zip member into a string, then continue the lazy walk. */
function readMember(
  zip: ZipFile,
  entry: ZipEntry,
  files: Map<string, string>,
  reject: (error: Error) => void,
): void {
  zip.openReadStream(entry, (error, stream) => {
    if (error || !stream) {
      zip.close();
      reject(error || new Error(`Unable to read ${entry.fileName}`));

      return;
    }

    const chunks: Buffer[] = [];

    stream.on('error', (streamError) => {
      zip.close();
      reject(streamError);
    });

    stream.on('data', (chunk) => chunks.push(chunk));

    stream.on('end', () => {
      files.set(
        entry.fileName.toLowerCase(),
        Buffer.concat(chunks).toString('utf8'),
      );

      zip.readEntry();
    });
  });
}

/** List a VSIX and read its manifest, package.json, and packaged changelog. */
function walkVsix(file: string): Promise<VsixWalk> {
  const wanted = new Set([
    'extension.vsixmanifest',
    'extension/package.json',
    PACKAGED_CHANGELOG,
  ]);

  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) {
        reject(error || new Error('Unable to open VSIX'));

        return;
      }

      const names: string[] = [];
      const files = new Map<string, string>();

      zip.on('error', (zipError) => {
        zip.close();
        reject(zipError);
      });

      zip.on('end', () => resolve({ names, files }));

      zip.on('entry', (entry: ZipEntry) => {
        names.push(entry.fileName);

        if (!wanted.has(entry.fileName.toLowerCase())) {
          zip.readEntry();

          return;
        }

        readMember(zip, entry, files, reject);
      });

      zip.readEntry();
    });
  });
}

/** package.json, both lockfile versions, and the top changelog section. */
function assertVersionFiles(root: string): string {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
  ) as { version?: unknown; name?: unknown; publisher?: unknown };

  const lock = JSON.parse(
    fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'),
  ) as { version?: unknown; packages?: { ''?: { version?: unknown } } };

  const version = pkg.version;

  if (typeof version !== 'string' || !stableVersion(version)) {
    throw new Error(
      `package.json version ${String(version)} is not stable X.Y.Z.`,
    );
  }

  if (pkg.name !== EXTENSION_ID || pkg.publisher !== PUBLISHER) {
    throw new Error(
      `package.json identity is ${String(pkg.publisher)}.${String(pkg.name)}.`,
    );
  }

  if (lock.version !== version || lock.packages?.['']?.version !== version) {
    throw new Error(
      `package-lock.json versions (${String(lock.version)}, ${String(lock.packages?.['']?.version)}) do not match ${version}.`,
    );
  }

  changelogSection(
    fs.readFileSync(path.join(root, CHANGELOG_FILE), 'utf8'),
    version,
  );

  return version;
}

/** Manifest and packaged package.json must name the same extension and version. */
function assertIdentity(files: Map<string, string>, version: string): void {
  const manifest = files.get('extension.vsixmanifest');
  const packaged = files.get('extension/package.json');
  const changelog = files.get(PACKAGED_CHANGELOG);

  if (!manifest || !packaged || !changelog) {
    throw new Error(
      'VSIX is missing its manifest, package.json, or changelog.md.',
    );
  }

  const identity = /<Identity\b[^>]*>/.exec(manifest)?.[0];

  /** Read one attribute from the Identity tag. */
  const value = (attribute: string): string | undefined =>
    identity
      ? new RegExp(`\\b${attribute}="([^"]*)"`).exec(identity)?.[1]
      : undefined;

  if (
    value('Id') !== EXTENSION_ID ||
    value('Publisher') !== PUBLISHER ||
    value('Version') !== version
  ) {
    throw new Error(
      `VSIX identity is ${value('Publisher') ?? '?'}.${value('Id') ?? '?'} ${value('Version') ?? '?'}.`,
    );
  }

  const inner = JSON.parse(packaged) as {
    name?: unknown;
    publisher?: unknown;
    version?: unknown;
  };

  if (
    inner.name !== EXTENSION_ID ||
    inner.publisher !== PUBLISHER ||
    inner.version !== version
  ) {
    throw new Error(
      'Packaged package.json does not match the extension identity.',
    );
  }

  changelogSection(changelog, version);
}

/** Reject development paths and confirm every `src` module compiled into the VSIX. */
async function main(): Promise<void> {
  const root = path.resolve(__dirname, '..');
  const vsix = path.join(root, 'dist', 'cursor-chat-transit.vsix');

  if (!fs.existsSync(vsix)) throw new Error('VSIX not found');
  const version = assertVersionFiles(root);
  const walked = await walkVsix(vsix);
  const names = new Set(walked.names);
  const foldedNames = new Set([...names].map((name) => name.toLowerCase()));

  for (const name of names) {
    const parts = name.split('/');

    if (
      parts.some((part) =>
        ['.git', 'tmp', 'test', '.dev', 'src'].includes(part),
      ) ||
      parts.includes('node_modules') ||
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
    'changelog.md',
    'LICENSE.txt',
    'resources/marketplace.png',
    'resources/icons/activity-bar.svg',
    'resources/sidebar.html',
    'resources/sidebar.css',
    'resources/sidebar-client.js',
    'vendor/yazl/index.js',
    'vendor/yauzl/index.js',
    'vendor/yauzl/fd-slicer.js',
    'vendor/buffer-crc32/index.js',
    'vendor/pend/index.js',
  ]) {
    if (!foldedNames.has(`extension/${required}`.toLowerCase()))
      throw new Error(`VSIX missing ${required}`);
  }

  assertIdentity(walked.files, version);
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
