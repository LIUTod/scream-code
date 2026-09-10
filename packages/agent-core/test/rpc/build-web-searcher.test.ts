import { describe, expect, it } from 'vitest';

import type { ScreamConfig } from '../../src/config';
import { buildWebSearcher } from '../../src/rpc/core-impl';
import { FallbackSearchProvider } from '../../src/tools/providers/fallback-search';

/**
 * Locks the default fallback-chain ORDER and the per-engine opt-out.
 * `buildWebSearcher` only reads `config.services`, so the fixture provides a
 * partial config cast to the full type.
 */
function searcherWith(services: Record<string, { enabled?: boolean }> | undefined) {
  return buildWebSearcher({ config: { services } as unknown as ScreamConfig });
}

describe('buildWebSearcher', () => {
  it('defaults to the DDG → Bing → Sogou → Baidu → 360 chain', () => {
    const searcher = searcherWith(undefined);
    expect(searcher).toBeInstanceOf(FallbackSearchProvider);
    expect((searcher as FallbackSearchProvider).providerNames).toEqual([
      'duckduckgo',
      'bing',
      'sogou',
      'baidu',
      '360',
    ]);
  });

  it('drops a disabled engine from the chain', () => {
    const searcher = searcherWith({ bing: { enabled: false } });
    expect((searcher as FallbackSearchProvider).providerNames).toEqual([
      'duckduckgo',
      'sogou',
      'baidu',
      '360',
    ]);
  });

  it('returns a single provider (not a chain) when only one engine remains', () => {
    const searcher = searcherWith({
      duckduckgo: { enabled: false },
      bing: { enabled: false },
      sogou: { enabled: false },
      baidu: { enabled: false },
    });
    expect(searcher).not.toBeInstanceOf(FallbackSearchProvider);
    expect(searcher?.name).toBe('360');
  });

  it('returns undefined when every engine is disabled (tool is not mounted)', () => {
    const searcher = searcherWith({
      duckduckgo: { enabled: false },
      bing: { enabled: false },
      sogou: { enabled: false },
      baidu: { enabled: false },
      so360: { enabled: false },
    });
    expect(searcher).toBeUndefined();
  });
});
