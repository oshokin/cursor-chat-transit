import path from 'node:path';

/** Maximum untrusted artifact path or URI inspected during validation. */
export const ARTIFACT_REFERENCE_TEXT_CHARS = 4_096;

/** Maximum recursion accepted while discovering or rewriting artifact snapshots. */
export const ARTIFACT_SNAPSHOT_DEPTH = 128;

/** Filesystem artifact kinds whose transfer support is intentionally explicit. */
export type ArtifactKind =
  'image' | 'plan' | 'canvas' | 'visualization' | 'terminal' | 'transcript';

/** Whether an artifact can be transferred from a stable chat reference. */
export interface ArtifactSupport {
  kind: ArtifactKind;
  status: 'supported' | 'degraded' | 'unsupported';
  reason?: string;
}

/** Current filesystem artifact support boundary. */
export const ARTIFACT_SUPPORT: Readonly<Record<ArtifactKind, ArtifactSupport>> =
  {
    image: { kind: 'image', status: 'supported' },
    plan: { kind: 'plan', status: 'supported' },
    canvas: { kind: 'canvas', status: 'supported' },
    visualization: {
      kind: 'visualization',
      status: 'degraded',
      reason:
        'Structured Cursor visualization references are recognized, but HTML is not restored until the archive resource contract can carry it inertly.',
    },
    terminal: {
      kind: 'terminal',
      status: 'unsupported',
      reason: 'No stable chat-owned terminal artifact reference is known.',
    },
    transcript: {
      kind: 'transcript',
      status: 'unsupported',
      reason: 'No stable chat-owned transcript artifact reference is known.',
    },
  };

/** Cursor visualization basename accepted by its renderer. */
export const VISUALIZATION_FILENAME =
  /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\.html$/i;

/** Basename only when a path structurally names `visualizations/{name}.html`. */
function visualizationFilenameFromPath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > ARTIFACT_REFERENCE_TEXT_CHARS)
    return null;
  const parts = value.replace(/\\/g, '/').split(/[?#]/, 1)[0].split('/');
  const filename = parts.pop() || '';

  if (parts.pop() !== 'visualizations') return null;

  return VISUALIZATION_FILENAME.test(filename) &&
    path.basename(filename) === filename
    ? filename
    : null;
}

/**
 * Recognize only the fields Cursor's artifact tool contract uses. Arbitrary
 * strings, message text, URI maps, and unrelated file paths are never scanned.
 */
export function visualizationFilenamesFromChat(
  bodyText: string | undefined,
  bubbles:
    | Array<{
        value: string;
      }>
    | undefined,
): string[] {
  const found = new Set<string>();

  /** Visit JSON containers while accepting only tool params as references. */
  const visit = (value: unknown, depth: number) => {
    if (depth > ARTIFACT_SNAPSHOT_DEPTH || !value || typeof value !== 'object')
      return;

    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);

      return;
    }

    const rec = value as Record<string, unknown>;

    const params =
      rec.params && typeof rec.params === 'object' && !Array.isArray(rec.params)
        ? (rec.params as Record<string, unknown>)
        : null;

    if (params) {
      for (const field of ['relativeWorkspacePath', 'targetFile'] as const) {
        const filename = visualizationFilenameFromPath(params[field]);

        if (filename) found.add(filename);
      }
    }

    for (const [key, nested] of Object.entries(rec)) {
      if (key === 'text' || key === 'rawText' || key === 'thinking') continue;
      visit(nested, depth + 1);
    }
  };

  for (const raw of [
    bodyText,
    ...(bubbles || []).map((bubble) => bubble.value),
  ]) {
    if (!raw) continue;

    try {
      visit(JSON.parse(raw), 0);
    } catch {
      /* Existing chat validation owns malformed JSON classification. */
    }
  }

  return [...found];
}
