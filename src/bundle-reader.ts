import { transferEvent, transferProgress } from './transfer-events';
import { readFile } from './trace-fs';
import { rm } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  BUNDLE_FORMAT,
  EXPORT_FORMAT_VERSION,
  MAX_MANIFEST_BYTES,
} from './bundle-limits';
import { extractZip, type ExtractedEntry } from './bundle-zip';
import { hashFile } from './hash-file';
import { readNdjson } from './ndjson-io';
import { parseBoundedJson } from './record-json';

/** Checked manifest. Only version 4 is accepted. */
export interface BundleManifest {
  /** Format name. */
  format: typeof BUNDLE_FORMAT;
  /** Format version. */
  formatVersion: typeof EXPORT_FORMAT_VERSION;
  /** Inventory file hash. */
  inventory: {
    /** Relative path of the inventory file. */
    path: string;
    /** Byte length of that file. */
    bytes: number;
    /** SHA-256 of that file. */
    sha256: string;
  };
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
): Promise<OpenBundle> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cct-bundle-'));

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
    await verifyInventory(root, manifest, byName, signal);

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
async function readManifest(root: string): Promise<BundleManifest> {
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

  if (rec.formatVersion !== EXPORT_FORMAT_VERSION) {
    throw new Error(
      `Unsupported export formatVersion ${String(rec.formatVersion)}. Export the chats again with the current extension.`,
    );
  }

  const inventory = rec.inventory as Record<string, unknown> | undefined;
  const counts = rec.counts as Record<string, unknown> | undefined;

  if (
    !inventory ||
    inventory.path !== 'inventory.ndjson' ||
    typeof inventory.sha256 !== 'string' ||
    typeof inventory.bytes !== 'number' ||
    !counts ||
    typeof counts.chats !== 'number' ||
    typeof counts.files !== 'number' ||
    typeof counts.contentBytes !== 'number'
  ) {
    throw new Error('Export manifest is missing inventory or counts.');
  }

  return {
    format: BUNDLE_FORMAT,
    formatVersion: EXPORT_FORMAT_VERSION,
    inventory: {
      path: 'inventory.ndjson',
      bytes: inventory.bytes,
      sha256: inventory.sha256,
    },
    counts: {
      chats: counts.chats,
      files: counts.files,
      contentBytes: counts.contentBytes,
    },
    source: rec.source,
    summary: rec.summary,
  };
}

/** Check `inventory.ndjson` against the manifest hash and extracted entries. */
async function verifyInventory(
  root: string,
  manifest: BundleManifest,
  entries: Map<string, ExtractedEntry>,
  signal?: AbortSignal,
): Promise<void> {
  const inventoryPath = path.join(root, 'inventory.ndjson');
  const hashed = await hashFile(inventoryPath, signal);

  if (
    hashed.sha256 !== manifest.inventory.sha256 ||
    hashed.bytes !== manifest.inventory.bytes
  ) {
    throw new Error('Export inventory does not match the manifest.');
  }

  const seen = new Set<string>();
  let contentBytes = 0;
  let lastProgress = performance.now();

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

    if (performance.now() - lastProgress >= 250) {
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
