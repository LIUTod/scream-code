/**
 * FallbackSearchProvider — chains multiple WebSearchProviders.
 *
 * Each provider in the chain is tried in order. The first provider to
 * return a non-empty result set wins. Providers that throw are silently
 * skipped so a single failing backend does not prevent results from
 * other backends further down the chain.
 *
 * Returns an empty array only when every provider returns empty or throws.
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
    options?: { limit?: number; includeContent?: boolean; toolCallId?: string },
  ): Promise<WebSearchResult[]> {
    for (const provider of this.providers) {
      try {
        const results = await provider.search(query, options);
        if (results.length > 0) {
          return results;
        }
      } catch {
        // Provider threw — skip to the next in the chain.
        continue;
      }
    }
    return [];
  }
}
