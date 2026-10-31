import { TransferError } from './types';

/** Version of the renderer KV ownership/remapping contract. */
export const CHAT_KV_REGISTRY_VERSION = 1 as const;

/** Renderer KV families which are portable with one chat. */
export type ChatKvFamily =
  | 'composerDraft'
  | 'composerConversationState'
  | 'checkpointId'
  | 'codeBlockDiff'
  | 'ofsContent'
  | 'checkpoint'
  | 'artifact'
  | 'bubbleCheckpoint';

/** A classified portable renderer KV key. */
export interface ChatKvKey {
  family: ChatKvFamily;
  key: string;
  /** Composer which directly owns the record, when encoded in its key. */
  composerId?: string;
  /** Auxiliary object id, when this is an agentKv record. */
  auxiliaryId?: string;
}

const COMPOSER_EXACT = ['composerDraft', 'composerConversationState'] as const;

const COMPOSER_PREFIX = [
  'checkpointId',
  'codeBlockDiff',
  'ofsContent',
] as const;

const AGENT_COMPOSER_EXACT = ['checkpoint'] as const;
const AGENT_COMPOSER_PREFIX = ['artifact', 'bubbleCheckpoint'] as const;

/** Classify a known renderer KV key. Unknown keys are deliberately ignored. */
export function classifyChatKvKey(key: string): ChatKvKey | null {
  for (const family of COMPOSER_EXACT) {
    const prefix = `${family}:`;

    if (
      key.startsWith(prefix) &&
      key.length > prefix.length &&
      !key.slice(prefix.length).includes(':')
    )
      return { family, key, composerId: key.slice(prefix.length) };
  }

  for (const family of COMPOSER_PREFIX) {
    const prefix = `${family}:`;

    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    const split = rest.indexOf(':');

    if (split <= 0 || split === rest.length - 1) return null;

    return { family, key, composerId: rest.slice(0, split) };
  }

  for (const family of AGENT_COMPOSER_EXACT) {
    const prefix = `agentKv:${family}:`;

    if (
      key.startsWith(prefix) &&
      key.length > prefix.length &&
      !key.slice(prefix.length).includes(':')
    )
      return { family, key, composerId: key.slice(prefix.length) };
  }

  for (const family of AGENT_COMPOSER_PREFIX) {
    const prefix = `agentKv:${family}:`;

    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    const split = rest.indexOf(':');

    if (split <= 0 || split === rest.length - 1) return null;

    return { family, key, composerId: rest.slice(0, split) };
  }

  return null;
}

/** SQL LIKE patterns which select records directly owned by a composer. */
export function chatKvOwnedPatterns(composerId: string): {
  exact: string[];
  prefixes: string[];
} {
  return {
    exact: [
      ...COMPOSER_EXACT.map((family) => `${family}:${composerId}`),
      ...AGENT_COMPOSER_EXACT.map(
        (family) => `agentKv:${family}:${composerId}`,
      ),
    ],
    prefixes: [
      ...COMPOSER_PREFIX.map((family) => `${family}:${composerId}:`),
      ...AGENT_COMPOSER_PREFIX.map(
        (family) => `agentKv:${family}:${composerId}:`,
      ),
    ],
  };
}

/** Remap only the composer-bearing segment of a registry key. */
export function remapChatKvKey(
  key: string,
  composerIds: ReadonlyMap<string, string>,
): string {
  const known = classifyChatKvKey(key);

  if (!known?.composerId) return key;
  const mapped = composerIds.get(known.composerId);

  if (!mapped) return key;

  const marker = `:${known.composerId}`;
  const offset = key.indexOf(marker);

  if (offset < 0) return key;

  return key.slice(0, offset + 1) + mapped + key.slice(offset + marker.length);
}

/**
 * Field names which may carry a fully-qualified agent KV pointer.
 * Bare checkpoint/artifact ids are not keys: Cursor's actual blob-store keys
 * are composer-owned and are selected from their prefixes separately.
 */
const AUX_POINTER_FIELDS: Readonly<Record<string, ChatKvFamily>> = {
  checkpointId: 'checkpoint',
  checkpointIds: 'checkpoint',
  checkpoint: 'checkpoint',
  artifactId: 'artifact',
  artifactIds: 'artifact',
  artifact: 'artifact',
  bubbleCheckpointId: 'bubbleCheckpoint',
  bubbleCheckpointIds: 'bubbleCheckpoint',
  bubbleCheckpoint: 'bubbleCheckpoint',
};

/** Return canonical auxiliary keys referenced at schema-known JSON fields. */
export function auxiliaryKeysFromJson(value: unknown): Set<string> {
  const result = new Set<string>();
  const seen = new Set<object>();

  /** Walk structured fields while considering values only at registered names. */
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (seen.has(node as object)) fail('Renderer KV record contains a cycle.');
    seen.add(node as object);

    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      seen.delete(node);

      return;
    }

    for (const [name, child] of Object.entries(
      node as Record<string, unknown>,
    )) {
      const family = AUX_POINTER_FIELDS[name];

      if (family) collectPointer(result, family, child);
      if (child && typeof child === 'object') walk(child);
    }

    seen.delete(node);
  };

  walk(value);

  return result;
}

/** Rewrite composer ids and auxiliary ids only at registry-known JSON fields. */
export function remapChatKvJson(
  value: unknown,
  composerIds: ReadonlyMap<string, string>,
  auxiliaryIds: ReadonlyMap<string, string> = new Map(),
): unknown {
  if (Array.isArray(value))
    return value.map((item) =>
      remapChatKvJson(item, composerIds, auxiliaryIds),
    );
  if (!value || typeof value !== 'object') return value;

  const output: Record<string, unknown> = {};

  for (const [name, child] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (name === 'composerId' || name === 'conversationId') {
      output[name] =
        typeof child === 'string' ? (composerIds.get(child) ?? child) : child;

      continue;
    }

    const family = AUX_POINTER_FIELDS[name];

    output[name] = family
      ? remapPointer(family, child, auxiliaryIds)
      : remapChatKvJson(child, composerIds, auxiliaryIds);
  }

  return output;
}

/** Parse a graph-bearing record and reject malformed/non-object JSON. */
export function parseChatKvJson(bytes: Buffer, key: string): unknown {
  try {
    const value: unknown = JSON.parse(bytes.toString('utf8'));

    if (!value || typeof value !== 'object')
      fail(`Renderer KV record ${key} is not a JSON object.`);

    return value;
  } catch (error) {
    if (error instanceof TransferError) throw error;
    fail(`Renderer KV record ${key} contains invalid JSON.`);
  }
}

function collectPointer(
  output: Set<string>,
  family: ChatKvFamily,
  value: unknown,
): void {
  if (Array.isArray(value)) {
    for (const item of value) collectPointer(output, family, item);

    return;
  }

  if (typeof value !== 'string' || !value.startsWith('agentKv:')) return;
  const classified = classifyChatKvKey(value);

  if (!classified || classified.family !== family)
    fail('Renderer KV auxiliary pointer has the wrong family.');
  output.add(value);
}

function remapPointer(
  family: ChatKvFamily,
  value: unknown,
  ids: ReadonlyMap<string, string>,
): unknown {
  if (Array.isArray(value))
    return value.map((item) => remapPointer(family, item, ids));
  if (typeof value !== 'string') return value;
  const prefix = `agentKv:${family}:`;

  if (value.startsWith(prefix)) {
    const id = value.slice(prefix.length);

    return prefix + (ids.get(id) ?? id);
  }

  return ids.get(value) ?? value;
}

function fail(message: string): never {
  const error = new TransferError(message);

  error.code = 'INVALID_RESOURCE';

  throw error;
}
