import { transferEvent, transferProgress } from './transfer-events';
import { readFile } from './trace-fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { operationTempDir } from './operation-temp';
import {
  BUNDLE_FORMAT,
  EXPORT_FORMAT_VERSION,
  MIN_BUNDLE_FORMAT_VERSION,
  MAX_MANIFEST_BYTES,
} from './bundle-limits';
import { extractZip, type ExtractedEntry } from './bundle-zip';
import { hashFile } from './hash-file';
import { readNdjson } from './ndjson-io';
import { parseBoundedJson } from './record-json';
import {
  validateBundleCapabilities,
  type BundleCapabilities,
} from './bundle-capabilities';
import { visitBundleIndex } from './bundle-index';
import { TRANSFER_PROGRESS_THROTTLE_MS } from './progress-model';

/** Checked manifest for a supported seekable bundle. */
export interface BundleManifest {
  format: typeof BUNDLE_FORMAT;
  formatVersion: number;
  /** v4 NDJSON inventory or v5 SQLite index hash. */
  inventory?: {
    /** Relative path of the inventory file. */
    path: string;
    /** Byte length of that file. */
    bytes: number;
    /** SHA-256 of that file. */
    sha256: string;
  };
  index?: {
    path: 'index.sqlite';
    bytes: number;
    sha256: string;
  };
  capabilities?: BundleCapabilities;
  /** Counts recorded by the exporter. */
  counts: {
    /** Chats recorded in the manifest. */
    chats: number;
    /** Files recorded in the manifest. */
    files: number;
    /** Uncompressed content bytes recorded in the manifest. */
    contentBytes: number;
  };
  /** Optional provenance. */
  source?: unknown;
  /** Export summary when the writer stored one. */
  summary?: unknown;
}

/** A verified staging directory for one archive. */
export interface OpenBundle {
  /** Staging root. Deleted by `close`. */
  root: string;
  /** Checked manifest. */
  manifest: BundleManifest;
  /** Delete the staging directory. */
  close(): Promise<void>;
}

/** Extract and verify an archive. Throws before the caller can treat it as data. */
export async function openBundle(
  zipPath: string,
  signal?: AbortSignal,
  /** Scratch parent captured for this operation. Empty uses the system temp directory. */
  temporaryDirectory?: string,
): Promise<OpenBundle> {
  const root = await operationTempDir('cct-bundle-', temporaryDirectory);

  transferEvent({
    action: 'Extract archive',
    status: 'started',
    source: zipPath,
    destination: root,
  });

  try {
    const entries = await extractZip(zipPath, root, signal);
    const manifest = await readManifest(root);

    const byName = new Map<string, ExtractedEntry>(
      entries.map((entry) => [entry.name, entry]),
    );

    transferProgress('validate', {});

    if (manifest.formatVersion === 4) {
      await verifyInventory(root, manifest, byName, signal);
    } else {
      await verifyIndex(root, manifest, byName, signal);
    }

    transferEvent({
      action: 'Extract and verify archive',
      status: 'completed',
      source: zipPath,
      destination: root,
      bytes: manifest.counts.contentBytes,
    });

    return {
      root,
      manifest,
      close: () => rm(root, { recursive: true, force: true }),
    };
  } catch (err) {
    await rm(root, { recursive: true, force: true });

    throw err;
  }
}

/** Load and validate `manifest.json`. */
async function readManifest(
  /** Directory that contains the extracted or staged archive. */
  root: string,
): Promise<BundleManifest> {
  const filePath = path.join(root, 'manifest.json');
  const bytes = await readFile(filePath);

  if (bytes.length > MAX_MANIFEST_BYTES) {
    throw new Error('Export manifest exceeds 1 MiB.');
  }

  const value = parseBoundedJson(bytes, 'manifest.json');

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Export manifest is not an object.');
  }

  const rec = value as Record<string, unknown>;

  if (rec.format !== BUNDLE_FORMAT) {
    throw new Error('This file is not a Cursor Chat Transit export.');
  }

  if (
    rec.formatVersion !== MIN_BUNDLE_FORMAT_VERSION &&
    rec.formatVersion !== EXPORT_FORMAT_VERSION
  ) {
    throw new Error(
      `Unsupported export formatVersion ${String(rec.formatVersion)}. Export the chats again with the current extension.`,
    );
  }

  const counts = rec.counts as Record<string, unknown> | undefined;

  if (
    !counts ||
    typeof counts.chats !== 'number' ||
    typeof counts.files !== 'number' ||
    typeof counts.contentBytes !== 'number'
  ) {
    throw new Error('Export manifest is missing inventory or counts.');
  }

  const manifest: BundleManifest = {
    format: BUNDLE_FORMAT,
    formatVersion: rec.formatVersion,
    counts: {
      chats: counts.chats,
      files: counts.files,
      contentBytes: counts.contentBytes,
    },
    source: rec.source,
    summary: rec.summary,
  };

  if (rec.formatVersion === 4) {
    const inventory = rec.inventory as Record<string, unknown> | undefined;

    if (
      !inventory ||
      inventory.path !== 'inventory.ndjson' ||
      typeof inventory.sha256 !== 'string' ||
      typeof inventory.bytes !== 'number'
    ) {
      throw new Error('Export manifest is missing its inventory.');
    }

    manifest.inventory = {
      path: 'inventory.ndjson',
      bytes: inventory.bytes,
      sha256: inventory.sha256,
    };
  } else {
    const index = rec.index as Record<string, unknown> | undefined;

    if (
      !index ||
      index.path !== 'index.sqlite' ||
      typeof index.sha256 !== 'string' ||
      typeof index.bytes !== 'number'
    ) {
      throw new Error('Export manifest is missing its index.');
    }

    manifest.index = {
      path: 'index.sqlite',
      bytes: index.bytes,
      sha256: index.sha256,
    };

    manifest.capabilities = validateBundleCapabilities(rec.capabilities);
  }

  return manifest;
}

/** Check `inventory.ndjson` against the manifest hash and extracted entries. */
async function verifyInventory(
  /** Directory that contains the extracted or staged archive. */
  root: string,
  /** Archive manifest. */
  manifest: BundleManifest,
  /** Entries to turn into picker rows. */
  entries: Map<string, ExtractedEntry>,
  signal?: AbortSignal,
): Promise<void> {
  const inventoryPath = path.join(root, 'inventory.ndjson');
  const inventory = manifest.inventory;

  if (!inventory) throw new Error('Export manifest is missing its inventory.');
  const hashed = await hashFile(inventoryPath, signal);

  if (hashed.sha256 !== inventory.sha256 || hashed.bytes !== inventory.bytes) {
    throw new Error('Export inventory does not match the manifest.');
  }

  const seen = new Set<string>();
  let contentBytes = 0;
  let lastProgress = performance.now();

  /** Report progress for this step. */
  const report = () =>
    transferProgress('validate', {
      scope: 'inventory',
      processed: seen.size,
      total: manifest.counts.files,
      unit: 'files',
    });

  report();

  for await (const row of readNdjson(
    inventoryPath,
    'inventory.ndjson',
    signal,
  )) {
    const rec = row.value as Record<string, unknown>;
    const name = rec.path;

    if (typeof name !== 'string' || typeof rec.sha256 !== 'string') {
      throw new Error('Export inventory row is invalid.');
    }

    if (name === 'manifest.json' || name === 'inventory.ndjson') {
      throw new Error('Export inventory lists its own manifest.');
    }

    if (seen.has(name))
      throw new Error(`Inventory lists ${name} more than once.`);
    seen.add(name);
    const entry = entries.get(name);

    if (!entry || entry.sha256 !== rec.sha256 || entry.bytes !== rec.bytes) {
      throw new Error(`Inventory does not match archive entry ${name}.`);
    }

    contentBytes += entry.bytes;

    if (performance.now() - lastProgress >= TRANSFER_PROGRESS_THROTTLE_MS) {
      lastProgress = performance.now();
      report();
    }
  }

  for (const name of entries.keys()) {
    if (name === 'manifest.json' || name === 'inventory.ndjson') continue;

    if (!seen.has(name))
      throw new Error(`Archive entry ${name} is not in the inventory.`);
  }

  if (
    seen.size !== manifest.counts.files ||
    contentBytes !== manifest.counts.contentBytes
  ) {
    throw new Error('Export manifest counts do not match the inventory.');
  }

  report();
}

/** Verify v5 metadata directly from the immutable on-disk SQLite index. */
async function verifyIndex(
  root: string,
  manifest: BundleManifest,
  entries: Map<string, ExtractedEntry>,
  signal?: AbortSignal,
): Promise<void> {
  const index = manifest.index;

  if (!index) throw new Error('Export manifest is missing its index.');
  const indexPath = path.join(root, index.path);
  const hashed = await hashFile(indexPath, signal);

  if (hashed.sha256 !== index.sha256 || hashed.bytes !== index.bytes) {
    throw new Error('Export index does not match the manifest.');
  }

  let files = 0;
  let contentBytes = 0;

  await visitBundleIndex(
    indexPath,
    {
      inventory: (row) => {
        const entry = entries.get(row.path);

        if (
          !entry ||
          entry.sha256 !== row.sha256 ||
          entry.bytes !== row.bytes
        ) {
          throw new Error(
            `Inventory does not match archive entry ${row.path}.`,
          );
        }

        entries.delete(row.path);
        files++;
        contentBytes += row.bytes;
      },
    },
    signal,
  );

  entries.delete('manifest.json');
  entries.delete('index.sqlite');

  if (entries.size) {
    throw new Error(
      `Archive entry ${entries.keys().next().value} is not in the index.`,
    );
  }

  if (
    files !== manifest.counts.files ||
    contentBytes !== manifest.counts.contentBytes
  ) {
    throw new Error('Export manifest counts do not match the index.');
  }
}
