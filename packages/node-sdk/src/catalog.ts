import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { ScreamConfig, ModelAlias } from '@scream-cli/agent-core';
import {
  catalogBaseUrl,
  catalogProviderModels,
  inferWireType,
  type Catalog,
  type CatalogModel,
  type CatalogProviderEntry,
  type ModelCapability,
  type ProviderType,
} from '@scream-cli/ltod';

export { catalogBaseUrl, catalogProviderModels, inferWireType };
export type { Catalog, CatalogModel, CatalogProviderEntry };

// ─── Catalog cache ────────────────────────────────────────────────────────

/** Path to the local catalog cache inside the scream home directory. */
export function catalogCachePath(screamHome: string): string {
  return join(screamHome, 'catalog-cache.json');
}

/**
 * Persist a successfully fetched catalog to local disk so it is available
 * the next time the network is unreachable.  Best-effort — write failures
 * are silently ignored so they never block the happy path.
 */
export function saveCatalogCache(catalog: Catalog, screamHome: string): void {
  try {
    const path = catalogCachePath(screamHome);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(catalog), 'utf-8');
  } catch {
    // best-effort cache
  }
}

/**
 * Load the most recently cached catalog snapshot.  Returns `undefined` when
 * no cache file exists or the file is corrupt.
 */
export function loadCatalogCache(screamHome: string): Catalog | undefined {
  try {
    const raw = readFileSync(catalogCachePath(screamHome), 'utf-8');
    return JSON.parse(raw) as Catalog;
  } catch {
    return undefined;
  }
}

export const DEFAULT_CATALOG_URL = 'https://models.dev/api.json';

export class CatalogFetchError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** Fetches a models.dev-style catalog. Public endpoint, no credentials needed. */
export async function fetchCatalog(
  url: string,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<Catalog> {
  const res = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal });
  if (!res.ok) {
    throw new CatalogFetchError(`Failed to fetch catalog (HTTP ${res.status}).`, res.status);
  }
  const payload: unknown = await res.json();
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error(`Unexpected catalog response from ${url}.`);
  }
  return payload as Catalog;
}

function capabilityToStrings(capability: ModelCapability): string[] | undefined {
  const caps: string[] = [];
  if (capability.image_in) caps.push('image_in');
  if (capability.video_in) caps.push('video_in');
  if (capability.audio_in) caps.push('audio_in');
  if (capability.thinking) caps.push('thinking');
  if (capability.tool_use) caps.push('tool_use');
  return caps.length > 0 ? caps : undefined;
}

/** Builds a scream-code model alias from a normalized catalog model. */
export function catalogModelToAlias(providerId: string, model: CatalogModel): ModelAlias {
  return {
    provider: providerId,
    model: model.id,
    maxContextSize: model.capability.max_context_tokens,
    maxOutputSize: model.maxOutputSize,
    capabilities: capabilityToStrings(model.capability),
    displayName: model.name,
    reasoningKey: model.reasoningKey,
  };
}

export interface ApplyCatalogProviderOptions {
  readonly providerId: string;
  readonly wire: ProviderType;
  readonly baseUrl?: string;
  readonly apiKey: string;
  readonly models: readonly CatalogModel[];
  readonly selectedModelId: string;
  readonly thinking: boolean;
}

/**
 * Parses an optional pruned models.dev catalog string — typically the
 * `__SCREAM_CODE_BUILT_IN_CATALOG__` constant injected by tsdown at build
 * time. Returns `undefined` when the argument is missing or invalid.
 */
export function loadBuiltInCatalog(text?: string): Catalog | undefined {
  if (typeof text !== 'string' || text.length === 0) return undefined;
  try {
    return JSON.parse(text) as Catalog;
  } catch {
    return undefined;
  }
}

/**
 * Writes a catalog-selected provider and its model aliases into `config` and
 * marks it the default. Model metadata (context, output limit, capabilities)
 * comes from the catalog, so the user does not hand-write it. Returns the
 * default model key.
 *
 * NOTE: the same-provider cleanup below mutates the passed-in `config` only.
 * It clears stale aliases on disk solely when the caller overwrites the whole
 * config. Callers persisting via `setConfig` — a deep-merge patch that cannot
 * delete keys — must call `removeProvider` first, or removed aliases reappear
 * after the merge.
 */
export function applyCatalogProvider(
  config: ScreamConfig,
  options: ApplyCatalogProviderOptions,
): { defaultModel: string } {
  config.providers[options.providerId] = {
    type: options.wire,
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
  };

  const models = config.models ?? {};
  for (const [key, alias] of Object.entries(models)) {
    if (alias.provider === options.providerId) delete models[key];
  }
  for (const model of options.models) {
    models[`${options.providerId}/${model.id}`] = catalogModelToAlias(options.providerId, model);
  }
  config.models = models;

  const defaultModel = `${options.providerId}/${options.selectedModelId}`;
  config.defaultModel = defaultModel;
  config.defaultThinking = options.thinking;
  return { defaultModel };
}
