import { describe, expect, it } from 'vitest';
import {
  addCost,
  estimateCost,
  formatUsd,
  priceForUsageKey,
  type ModelPrice,
} from '../src/cost';
import { emptyUsage } from '../src/usage';

const priced: ModelPrice = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };

describe('estimateCost', () => {
  it('prices each bucket at its own rate (USD per 1M tokens)', () => {
    const usage = {
      ...emptyUsage(),
      inputOther: 1_000_000,
      inputCacheRead: 2_000_000,
      inputCacheCreation: 500_000,
      output: 100_000,
    };
    // 1×3 + 2×0.3 + 0.5×3.75 + 0.1×15 = 3 + 0.6 + 1.875 + 1.5
    expect(estimateCost(usage, priced)).toBeCloseTo(6.975, 10);
  });

  it('falls back to the input rate when cache rates are absent', () => {
    const usage = {
      ...emptyUsage(),
      inputCacheRead: 1_000_000,
      inputCacheCreation: 1_000_000,
    };
    const cost = estimateCost(usage, { input: 2, output: 8 });
    expect(cost).toBeCloseTo(4, 10); // 1×2 + 1×2
  });

  it('returns undefined for an unpriced model, never $0.00', () => {
    expect(estimateCost(emptyUsage(), undefined)).toBeUndefined();
  });

  it('returns 0 for a priced model with no usage', () => {
    expect(estimateCost(emptyUsage(), priced)).toBe(0);
  });
});

describe('addCost', () => {
  it('propagates undefined instead of inventing zero', () => {
    expect(addCost(undefined, undefined)).toBeUndefined();
    expect(addCost(1, undefined)).toBe(1);
    expect(addCost(undefined, 2)).toBe(2);
    expect(addCost(1, 2)).toBe(3);
  });
});

describe('formatUsd', () => {
  it('uses four decimals and an em dash for unpriced', () => {
    expect(formatUsd(0.5)).toBe('$0.5000');
    expect(formatUsd(0)).toBe('$0.0000');
    expect(formatUsd(undefined)).toBe('—');
  });
});

describe('priceForUsageKey', () => {
  const LARGE: ModelPrice = { input: 3, output: 15 };
  const OTHER: ModelPrice = { input: 1, output: 2 };
  const catalog = new Map<string, ModelPrice>([
    ['acme-large', LARGE],
    ['acme/acme-large', LARGE],
    ['ds-fast', OTHER],
  ]);
  const lookup = (id: string) => catalog.get(id);

  it('prices a hand-named alias by the catalog model it names', () => {
    expect(priceForUsageKey('my-fast', { provider: 'gateway', model: 'acme-large' }, lookup)).toBe(LARGE);
  });

  it('prefers the provider-qualified spelling when the provider is a catalog id', () => {
    expect(priceForUsageKey('x', { provider: 'acme', model: 'acme-large' }, lookup)).toBe(LARGE);
  });

  it('resolves through the alias before the key itself', () => {
    // The key happens to name a different catalog model than the alias does.
    expect(priceForUsageKey('ds-fast', { provider: 'gateway', model: 'acme-large' }, lookup)).toBe(LARGE);
  });

  it('falls back to the key (catalog-built `provider/model` aliases, unknown alias)', () => {
    expect(priceForUsageKey('acme/acme-large', undefined, lookup)).toBe(LARGE);
    expect(priceForUsageKey('ds-fast', { model: 'not-in-catalog' }, lookup)).toBe(OTHER);
  });

  it('is undefined when nothing prices', () => {
    expect(priceForUsageKey('custom', { model: 'unknown' }, lookup)).toBeUndefined();
  });
});
