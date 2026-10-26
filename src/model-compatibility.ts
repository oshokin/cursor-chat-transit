import * as db from './db';
import { createHash } from 'node:crypto';
import { canonicalJson } from './import-policy';
import type { SqliteConn } from './types';

/** Cursor application-user state that contains non-secret model metadata. */
export const APPLICATION_USER_STATE_KEY =
  'src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser';

/** Version of the destination-only model projection algorithm. */
export const MODEL_PROJECTION_VERSION = 'model-compat-v2';

/** One selected model parameter persisted by Cursor. */
export interface StoredModelParameter {
  /** Parameter identifier such as `fast` or `reasoning_effort`. */
  id: string;
  /** Persisted scalar value. */
  value: string | number | boolean;
}

/** One selected model and its variant parameters. */
export interface StoredSelectedModel {
  /** Cursor model identifier. */
  modelId: string;
  /** Parameters understood by that model. */
  parameters: StoredModelParameter[];
}

/** Portable, non-secret subset of Cursor's per-composer model config. */
export interface StoredModelConfig {
  /** Legacy model identifier retained by current Cursor builds. */
  modelName: string;
  /** Whether Cursor's extended-context mode is selected. */
  maxMode: boolean;
  /** Current parameterized model selections. */
  selectedModels: StoredSelectedModel[];
}

/** Destination model facts safe to send to the transfer worker. */
export interface ModelImportPolicy {
  /** Model identifiers usable by this destination profile. */
  availableModelIds: string[];
  /** Destination selection used when an archived model is unavailable. */
  fallback: StoredModelConfig;
}

/** Result of comparing one archived model config with the destination. */
export interface ModelConfigResolution {
  /** Config to persist in the imported composer. */
  config: unknown;
  /** Whether the archived config had to be replaced. */
  replaced: boolean;
  /** Archived model identifier suitable for a non-secret diagnostic. */
  sourceModel?: string;
  /** Replacement model identifier suitable for a non-secret diagnostic. */
  fallbackModel?: string;
}

/** Read only the non-secret model metadata needed by import. */
export async function readModelImportPolicy(
  conn: SqliteConn,
): Promise<ModelImportPolicy> {
  let raw: string | null;

  try {
    raw = await db.readItemText(conn, APPLICATION_USER_STATE_KEY);
  } catch {
    return defaultPolicy();
  }

  if (raw === null) return defaultPolicy();

  let state: unknown;

  try {
    state = JSON.parse(raw);
  } catch {
    return defaultPolicy();
  }

  if (!isObject(state)) return defaultPolicy();
  const aiSettings = objectAt(state, 'aiSettings');
  const modelConfigs = objectAt(aiSettings, 'modelConfig');

  const current =
    storedModelConfig(objectAt(modelConfigs, 'composer')) || defaultConfig();

  const available = new Set<string>(modelIds(current));
  const builtIn = new Set<string>();

  addCatalogIds(builtIn, state.availableDefaultModels2);

  for (const id of stringArray(aiSettings.modelOverrideDisabled)) {
    builtIn.delete(id);
  }

  for (const id of builtIn) available.add(id);
  addModelIds(available, state.availableAPIKeyModels);
  addModelIds(available, aiSettings.userAddedModels);
  addModelIds(available, aiSettings.modelOverrideEnabled);
  available.add('default');

  return {
    availableModelIds: [...available].sort(),
    fallback: current,
  };
}

/** Preserve an available archived model or replace it with the destination selection. */
export function resolveModelConfig(
  value: unknown,
  policy: ModelImportPolicy,
): ModelConfigResolution {
  if (value === undefined) return { config: value, replaced: false };
  const source = storedModelConfig(value);
  const available = new Set(policy.availableModelIds);

  if (
    source &&
    modelIds(source).length > 0 &&
    modelIds(source).every((id) => available.has(id))
  ) {
    return { config: value, replaced: false };
  }

  const fallback = storedModelConfig(policy.fallback) || defaultConfig();

  return {
    config: fallback,
    replaced: true,
    sourceModel: source ? primaryModel(source) : undefined,
    fallbackModel: primaryModel(fallback),
  };
}

/** True when two JSON model configs have the same stored value. */
export function sameModelConfig(left: unknown, right: unknown): boolean {
  return modelConfigHash(left) === modelConfigHash(right);
}

/** Stable ownership hash for one JSON model config. */
export function modelConfigHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/** Safe default when Cursor's application-user state is absent or unreadable. */
function defaultPolicy(): ModelImportPolicy {
  return { availableModelIds: ['default'], fallback: defaultConfig() };
}

/** Cursor's routed default model. */
function defaultConfig(): StoredModelConfig {
  return {
    modelName: 'default',
    maxMode: false,
    selectedModels: [{ modelId: 'default', parameters: [] }],
  };
}

/** Parse and copy the model fields without retaining unrelated profile data. */
function storedModelConfig(value: unknown): StoredModelConfig | null {
  if (!isObject(value)) return null;

  const modelName =
    typeof value.modelName === 'string' && value.modelName
      ? value.modelName
      : undefined;

  const selectedModels = selectedModelArray(value.selectedModels);

  if (!modelName && selectedModels.length === 0) return null;

  return {
    modelName: modelName || selectedModels[0]!.modelId,
    maxMode: value.maxMode === true,
    selectedModels:
      selectedModels.length > 0
        ? selectedModels
        : [{ modelId: modelName!, parameters: [] }],
  };
}

/** Parse selected models while discarding malformed and unknown fields. */
function selectedModelArray(value: unknown): StoredSelectedModel[] {
  if (!Array.isArray(value)) return [];
  const result: StoredSelectedModel[] = [];

  for (const item of value) {
    if (!isObject(item) || typeof item.modelId !== 'string' || !item.modelId)
      continue;
    const parameters: StoredModelParameter[] = [];

    if (Array.isArray(item.parameters)) {
      for (const parameter of item.parameters) {
        if (
          isObject(parameter) &&
          typeof parameter.id === 'string' &&
          parameter.id &&
          (typeof parameter.value === 'string' ||
            typeof parameter.value === 'number' ||
            typeof parameter.value === 'boolean')
        ) {
          parameters.push({ id: parameter.id, value: parameter.value });
        }
      }
    }

    result.push({ modelId: item.modelId, parameters });
  }

  return result;
}

/** Ordered model ids represented by one config. */
function modelIds(config: StoredModelConfig): string[] {
  const selected = config.selectedModels.map((item) => item.modelId);

  return [...new Set(selected.length ? selected : [config.modelName])];
}

/** Human-readable non-secret model identifier. */
function primaryModel(config: StoredModelConfig): string {
  return config.selectedModels[0]?.modelId || config.modelName;
}

/** Add model identifiers from strings or common Cursor model objects. */
function addModelIds(target: Set<string>, value: unknown): void {
  if (!Array.isArray(value)) return;

  for (const item of value) {
    if (typeof item === 'string' && item) {
      target.add(item);
    } else if (isObject(item)) {
      for (const key of ['modelId', 'serverModelName', 'name']) {
        const id = item[key];

        if (typeof id === 'string' && id) target.add(id);
      }
    }
  }
}

/** Add built-in model ids and aliases from Cursor's current catalog. */
function addCatalogIds(target: Set<string>, value: unknown): void {
  if (!Array.isArray(value)) return;

  for (const item of value) {
    if (!isObject(item) || item.defaultOn === false) continue;
    addModelIds(target, [item]);
    addModelIds(target, item.legacySlugs);
    addModelIds(target, item.idAliases);
  }
}

/** String array, excluding malformed values. */
function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && !!item)
    : [];
}

/** Child object, or an empty object when absent. */
function objectAt(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const child = value[key];

  return isObject(child) ? child : {};
}

/** True for a plain JSON object shape. */
function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
