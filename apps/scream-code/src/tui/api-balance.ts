/**
 * TUI-side provider balance lookup.
 *
 * Reads the runtime config.toml (same file the engine consumes), resolves
 * the plaintext API key (direct value or the provider's ENV_VAR env
 * reference), and delegates the actual query to the engine's
 * fetchProviderBalance. Results are cached briefly so footer renders do
 * not hammer the vendor endpoint.
 */

import { join } from 'node:path';
import {
  fetchProviderBalance,
  isSupportedBalanceProvider,
  readConfigFile,
  type ProviderBalance,
} from '@scream-code/agent-core';
import { getDataDir } from '../utils/paths';

const BALANCE_CACHE_MS = 60_000;

interface CachedBalance {
  balance: ProviderBalance | null;
  at: number;
}

const cache = new Map<string, CachedBalance>();
/** Monotonic id so an out-of-order lookup can never overwrite a newer one. */
let latestRequestId = 0;

function resolveApiKey(providerName: string): string | undefined {
  const config = readConfigFile(join(getDataDir(), 'config.toml'));
  const provider = config.providers?.[providerName];
  if (!provider) return undefined;
  const direct = provider.apiKey?.trim();
  if (direct !== undefined && direct.length > 0) return direct;
  // Match the engine's providerApiKey convention (provider-manager.ts):
  // env values are stored under a key derived from the provider type.
  const envKey = envKeyForProviderType(provider.type);
  const stored = envKey !== undefined ? provider.env?.[envKey]?.trim() : undefined;
  return stored !== undefined && stored.length > 0 ? stored : undefined;
}

function envKeyForProviderType(type: string | undefined): string | undefined {
  switch (type) {
    case 'anthropic':
      return 'ANTHROPIC_API_KEY';
    case 'openai':
    case 'openai_responses':
      return 'OPENAI_API_KEY';
    case 'scream':
      return 'SCREAM_API_KEY';
    case 'google-genai':
      return 'GOOGLE_API_KEY';
    case 'vertexai':
      return 'VERTEXAI_API_KEY';
    default:
      return undefined;
  }
}

async function loadBalance(providerName: string): Promise<ProviderBalance | null> {
  try {
    const config = readConfigFile(join(getDataDir(), 'config.toml'));
    const provider = config.providers?.[providerName];
    if (!provider?.baseUrl) return null;
    const apiKey = resolveApiKey(providerName);
    if (apiKey === undefined) return null;
    return await fetchProviderBalance(provider.baseUrl, apiKey);
  } catch {
    return null; // unreadable config / network failure → hide the balance
  }
}

/**
 * Look up the balance for the provider that serves the given model
 * (model names follow the "provider/model" convention). Returns null when
 * the provider is unknown, unofficial, or the lookup failed — callers
 * render nothing in that case. Cached for BALANCE_CACHE_MS per provider.
 */
export async function getProviderBalanceForModel(
  model: string,
): Promise<ProviderBalance | null> {
  const providerName = model.split('/')[0] ?? '';
  if (providerName.length === 0) return null;
  const cached = cache.get(providerName);
  if (cached !== undefined && Date.now() - cached.at < BALANCE_CACHE_MS) {
    return cached.balance;
  }
  const balance = await loadBalance(providerName);
  cache.set(providerName, { balance, at: Date.now() });
  return balance;
}

/**
 * True when the given model is served by a provider whose balance we can
 * query. Pure local check (config lookup + hostname match, no network) —
 * the poller uses it to skip unsupported providers entirely.
 */
export function supportsBalance(model: string): boolean {
  const providerName = model.split('/')[0] ?? '';
  if (providerName.length === 0) return false;
  try {
    const config = readConfigFile(join(getDataDir(), 'config.toml'));
    const baseUrl = config.providers?.[providerName]?.baseUrl;
    return baseUrl !== undefined && isSupportedBalanceProvider(baseUrl);
  } catch {
    return false;
  }
}

/** Drop cached balances so the next lookup hits the vendor again. */
export function invalidateBalanceCache(): void {
  cache.clear();
}

/**
 * Fetch the balance for a model and push it into app state. Fire-and-forget:
 * failures resolve to null inside getProviderBalanceForModel, so callers
 * (startup sync and model switches) never await it. A request id guards
 * against out-of-order resolutions: when the user switches models quickly,
 * only the latest lookup's result is committed.
 */
export function refreshProviderBalance(
  model: string,
  setAppState: (patch: {
    providerBalance: ProviderBalance | null;
    balanceUpdatedAt: number;
  }) => void,
): void {
  const requestId = ++latestRequestId;
  void getProviderBalanceForModel(model).then((balance) => {
    if (requestId !== latestRequestId) return; // superseded by a newer lookup
    // balanceUpdatedAt drives the footer flash on every completed fetch,
    // regardless of whether the value itself changed.
    setAppState({ providerBalance: balance, balanceUpdatedAt: Date.now() });
  });
}
