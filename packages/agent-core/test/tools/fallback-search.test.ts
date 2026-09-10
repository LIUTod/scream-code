import { describe, expect, it, vi } from 'vitest';

import type { WebSearchProvider, WebSearchResult } from '../../src/tools/builtin';
import { FallbackSearchProvider } from '../../src/tools/providers/fallback-search';

const RESULT: WebSearchResult = { title: 'T', url: 'https://example.com/', snippet: 'S' };

function okProvider(name: string, results: WebSearchResult[]): WebSearchProvider {
  return { name, search: vi.fn(async () => results) };
}

function failProvider(name: string, message: string): WebSearchProvider {
  return {
    name,
    search: vi.fn(async () => {
      throw new Error(message);
    }),
  };
}

/** Blocks until its (budget-derived) signal aborts, then rejects. */
function hangProvider(name: string): WebSearchProvider {
  return {
    name,
    search: vi.fn(
      async (_query, options) =>
        await new Promise<WebSearchResult[]>((_resolve, reject) => {
          const abort = () => {
            reject(new Error('aborted by deadline'));
          };
          if (options?.signal?.aborted === true) {
            abort();
            return;
          }
          options?.signal?.addEventListener('abort', abort, { once: true });
        }),
    ),
  };
}

describe('FallbackSearchProvider', () => {
  it('exposes providerNames in chain order', () => {
    const chain = new FallbackSearchProvider([
      okProvider('first', []),
      okProvider('second', []),
    ]);
    expect(chain.providerNames).toEqual(['first', 'second']);
  });

  it('returns the first non-empty result and stops the chain', async () => {
    const failing = failProvider('one', 'boom');
    const winning = okProvider('two', [RESULT]);
    const neverReached = okProvider('three', [RESULT]);
    const chain = new FallbackSearchProvider([failing, winning, neverReached]);

    await expect(chain.search('q')).resolves.toEqual([RESULT]);
    expect(neverReached.search).not.toHaveBeenCalled();
  });

  it('returns [] when every provider ran cleanly but found nothing', async () => {
    const chain = new FallbackSearchProvider([okProvider('one', []), okProvider('two', [])]);
    await expect(chain.search('q')).resolves.toEqual([]);
  });

  it('aggregates per-provider failure reasons when everything fails', async () => {
    const chain = new FallbackSearchProvider([
      failProvider('one', 'HTTP 429'),
      failProvider('two', 'challenge page'),
    ]);
    await expect(chain.search('q')).rejects.toThrow(/HTTP 429[\s\S]*challenge page|challenge page[\s\S]*HTTP 429/);
  });

  it('bounds the total wait with the chain budget when a provider hangs', async () => {
    const hanging = hangProvider('stuck');
    const neverReached = okProvider('later', [RESULT]);
    // Budget above the 2s floor so the first attempt actually runs, small
    // enough to keep the test fast; the abort comes from the remaining budget.
    const chain = new FallbackSearchProvider([hanging, neverReached], { totalBudgetMs: 2_500 });

    const startedAt = Date.now();
    await expect(chain.search('q')).rejects.toThrow(/budget \(3s\) exhausted/);
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(8_000);
    expect(neverReached.search).not.toHaveBeenCalled();
  }, 15_000);

  it('propagates caller cancellation instead of treating it as a provider failure', async () => {
    const controller = new AbortController();
    const hanging = hangProvider('stuck');
    const chain = new FallbackSearchProvider([hanging], { totalBudgetMs: 30_000 });

    const promise = chain.search('q', { signal: controller.signal });
    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  });
});
