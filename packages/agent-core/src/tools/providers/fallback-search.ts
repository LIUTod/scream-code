/**
 * FallbackSearchProvider — chains multiple WebSearchProviders.
 *
 * Each provider is tried in order; the first to return a non-empty result
 * set wins. A provider that throws no longer vanishes silently: its failure
 * reason is recorded and the chain advances. When every provider fails, the
 * collected reasons surface as one aggregated error so the model (and user)
 * can see WHY each backend failed instead of a bare "No search results
 * found" that hides network/auth problems.
 *
 * User cancellation (`options.signal`) aborts the chain immediately — an
 * in-flight Esc is never mistaken for a provider failure.
 *
 * Returns an empty array only when every provider ran cleanly but found
 * nothing.
 */

import type { WebSearchProvider, WebSearchResult } from '../builtin';

export class FallbackSearchProvider implements WebSearchProvider {
  private readonly providers: readonly WebSearchProvider[];

  constructor(providers: readonly WebSearchProvider[]) {
    if (providers.length === 0) {
      throw new Error('FallbackSearchProvider requires at least one provider');
    }
    this.providers = providers;
  }

  async search(
    query: string,
    options?: { limit?: number; includeContent?: boolean; toolCallId?: string; signal?: AbortSignal },
  ): Promise<WebSearchResult[]> {
    const failures: { provider: string; reason: string }[] = [];
    for (const [index, provider] of this.providers.entries()) {
      options?.signal?.throwIfAborted();
      try {
        const results = await provider.search(query, options);
        if (results.length > 0) {
          return results;
        }
        failures.push({ provider: provider.name ?? `provider ${String(index + 1)}`, reason: 'no results' });
      } catch (error) {
        // Esc during the request: surface cancellation, don't chain on.
        options?.signal?.throwIfAborted();
        failures.push({
          provider: provider.name ?? `provider ${String(index + 1)}`,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    // Every provider ran but found nothing — a genuine "no results", not an error.
    if (failures.every((f) => f.reason === 'no results')) {
      return [];
    }
    // Single-provider chain: surface the raw reason without the aggregate
    // wrapper (mirrors the pre-chain behavior for one configured backend).
    const last = failures[failures.length - 1];
    if (this.providers.length === 1 && last !== undefined) {
      throw new Error(last.reason);
    }
    const summary = failures.map((f) => `${f.provider}: ${f.reason}`).join('; ');
    throw new Error(`All web search providers failed — ${summary}`);
  }
}
