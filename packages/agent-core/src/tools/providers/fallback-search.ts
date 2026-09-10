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
 * A chain-level budget bounds the TOTAL wait across providers: each attempt
 * receives the remaining budget as its deadline (composed onto the caller's
 * signal), and the loop stops once the budget is exhausted — a dead network
 * path can no longer stack N × per-request ceilings.
 *
 * Returns an empty array only when every provider ran cleanly but found
 * nothing.
 */

import type { WebSearchProvider, WebSearchResult } from '../builtin';

/** Total wall-clock budget for the whole chain (all providers combined). */
export const SEARCH_CHAIN_BUDGET_MS = 40_000;

export interface FallbackSearchProviderOptions {
  /** Override the chain-level budget (tests, advanced tuning). */
  totalBudgetMs?: number;
}

export class FallbackSearchProvider implements WebSearchProvider {
  private readonly providers: readonly WebSearchProvider[];
  private readonly totalBudgetMs: number;

  constructor(providers: readonly WebSearchProvider[], options: FallbackSearchProviderOptions = {}) {
    if (providers.length === 0) {
      throw new Error('FallbackSearchProvider requires at least one provider');
    }
    this.providers = providers;
    this.totalBudgetMs = options.totalBudgetMs ?? SEARCH_CHAIN_BUDGET_MS;
  }

  /** Names of the chained providers, in order (useful for tests/diagnostics). */
  get providerNames(): string[] {
    return this.providers.map((provider, index) => provider.name ?? `provider ${String(index + 1)}`);
  }

  async search(
    query: string,
    options?: { limit?: number; includeContent?: boolean; toolCallId?: string; signal?: AbortSignal },
  ): Promise<WebSearchResult[]> {
    const failures: { provider: string; reason: string }[] = [];
    const deadline = Date.now() + this.totalBudgetMs;
    let ranAllProviders = true;
    for (const [index, provider] of this.providers.entries()) {
      options?.signal?.throwIfAborted();
      const remaining = deadline - Date.now();
      if (remaining <= 2_000) {
        failures.push({
          provider: 'chain',
          reason: `budget (${String(Math.round(this.totalBudgetMs / 1000))}s) exhausted after ${String(index)}/${String(this.providers.length)} providers`,
        });
        ranAllProviders = false;
        break;
      }
      try {
        // Bound this attempt by the remaining chain budget so an in-flight
        // request can never outlive it (providers compose this onto their own
        // hard timeout, taking the tighter of the two).
        const attemptSignal =
          options?.signal !== undefined
            ? AbortSignal.any([options.signal, AbortSignal.timeout(remaining)])
            : AbortSignal.timeout(remaining);
        const results = await provider.search(query, { ...options, signal: attemptSignal });
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
        // Budget ran out mid-request → do not start the next provider.
        if (Date.now() >= deadline) {
          ranAllProviders = false;
          failures.push({
            provider: 'chain',
            reason: `budget (${String(Math.round(this.totalBudgetMs / 1000))}s) exhausted after ${String(index + 1)}/${String(this.providers.length)} providers`,
          });
          break;
        }
      }
    }
    void ranAllProviders;
    // Every provider ran but found nothing — a genuine "no results", not an error.
    if (failures.every((f) => f.reason === 'no results')) {
      return [];
    }
    // (budget notes carry the 'chain' pseudo-provider; they skip the pure
    // no-results shortcut above by design so the caller learns the chain was
    // cut short.)
    // Single-provider chain: surface the raw reason without the aggregate
    // wrapper (mirrors the pre-chain behavior for one configured backend).
    const last = failures.at(-1);
    if (this.providers.length === 1 && last !== undefined) {
      throw new Error(last.reason);
    }
    const summary = failures.map((f) => `${f.provider}: ${f.reason}`).join('; ');
    throw new Error(`All web search providers failed — ${summary}`);
  }
}
