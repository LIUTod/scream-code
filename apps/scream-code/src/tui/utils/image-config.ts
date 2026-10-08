import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { resolveScreamHome } from '@scream-code/scream-code-sdk';

/** Summary of a usable image-generation config (never exposes the key). */
export interface ImageConfigSummary {
  readonly provider: string;
  readonly model: string;
  readonly url: string;
}

export function getImageConfigPath(): string {
  return join(resolveScreamHome(), 'image-config.json');
}

/** Placeholder rules mirrored from the ImageGenerate tool's `isPlaceholder`. */
function isPlaceholder(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length === 0 ||
    trimmed.includes('replace-with') ||
    (trimmed.startsWith('<') && trimmed.endsWith('>'))
  );
}

/**
 * Best-effort read of an existing image config (never throws, never exposes
 * the key). The `usable` predicate mirrors the ImageGenerate tool's
 * `loadConfig` (packages/agent-core/src/tools/builtin/image/image-generate.ts):
 * a config the tool would reject must never be advertised as "configured".
 */
export async function readExistingImageConfig(): Promise<ImageConfigSummary | undefined> {
  try {
    const text = await readFile(getImageConfigPath(), 'utf8');
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const urlRaw = typeof parsed['url'] === 'string' ? parsed['url'] : '';
    // Legacy (pre-full-URL) configs stored a base URL; the placeholder check
    // must run on the base URL itself (as the tool does) — composing first
    // would strip an angle-wrapped placeholder of its `>` and accept it.
    const legacyRaw = typeof parsed['base_url'] === 'string' ? parsed['base_url'] : '';
    const url = !isPlaceholder(urlRaw)
      ? urlRaw.trim()
      : !isPlaceholder(legacyRaw)
        ? `${legacyRaw.trim().replace(/\/+$/, '')}/images/generations`
        : '';
    const model = typeof parsed['model'] === 'string' ? parsed['model'].trim() : '';
    const apiKeyRaw = typeof parsed['api_key'] === 'string' ? parsed['api_key'] : '';
    // Mirror `loadConfig`: non-placeholder url + api_key, model a string.
    // Deliberately stricter on one point: a blank model reports "not
    // configured" (the tool would accept `model: ""` and fail at request
    // time), so the /model status line never advertises a dead setup.
    const usable = url.length > 0 && model.length > 0 && !isPlaceholder(apiKeyRaw);
    if (usable) {
      return {
        provider: typeof parsed['provider'] === 'string' ? parsed['provider'] : 'openai-compatible',
        model,
        url,
      };
    }
  } catch {
    // Missing or malformed file — treat as unconfigured.
  }
  return undefined;
}
