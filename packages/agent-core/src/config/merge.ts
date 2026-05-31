import { ErrorCodes, ScreamError } from '#/errors';
import {
  ScreamConfigPatchSchema,
  formatConfigValidationError,
  type ScreamConfig,
  type ScreamConfigPatch,
  validateConfig,
} from '#/config/schema';

export function mergeConfigPatch(config: ScreamConfig, patch: ScreamConfigPatch): ScreamConfig {
  const base = validateConfig(config);
  const parsedPatch = parsePatch(patch);
  const merged = deepMerge(base, parsedPatch);
  return validateConfig(merged);
}

function parsePatch(patch: ScreamConfigPatch): ScreamConfigPatch {
  try {
    return stripUndefinedDeep(ScreamConfigPatchSchema.parse(patch)) as ScreamConfigPatch;
  } catch (error) {
    throw new ScreamError(ErrorCodes.CONFIG_INVALID, `Invalid configuration patch: ${formatConfigValidationError(error)}`, {
      cause: error,
    });
  }
}

function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...target };
  for (const [key, sourceValue] of Object.entries(source)) {
    if (sourceValue === undefined) continue;
    const targetValue = result[key];
    if (isPlainObject(targetValue) && isPlainObject(sourceValue)) {
      result[key] = deepMerge(targetValue, sourceValue);
    } else {
      result[key] = sourceValue;
    }
  }
  return result;
}

function stripUndefinedDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripUndefinedDeep);
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, entryValue] of Object.entries(value)) {
    if (entryValue !== undefined) {
      out[key] = stripUndefinedDeep(entryValue);
    }
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
