/** Capabilities that affect whether a bundle can be interpreted safely. */
export interface BundleCapabilities {
  required: string[];
  optional: string[];
}

/** Capabilities implemented by this reader. */
export const SUPPORTED_BUNDLE_CAPABILITIES = new Set([
  'sqlite-index-v1',
  'content-addressed-blobs-v1',
]);

/** Validate capability lists and reject semantics this reader cannot preserve. */
export function validateBundleCapabilities(value: unknown): BundleCapabilities {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Export manifest is missing capabilities.');
  }

  const rec = value as Record<string, unknown>;
  const required = stringList(rec.required, 'required');
  const optional = stringList(rec.optional, 'optional');

  for (const capability of required) {
    if (!SUPPORTED_BUNDLE_CAPABILITIES.has(capability)) {
      throw new Error(`Unsupported required bundle capability: ${capability}`);
    }
  }

  return { required, optional };
}

function stringList(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`Export manifest ${name} capabilities are invalid.`);
  }

  const result = value as string[];

  if (new Set(result).size !== result.length) {
    throw new Error(`Export manifest ${name} capabilities contain duplicates.`);
  }

  return result;
}
