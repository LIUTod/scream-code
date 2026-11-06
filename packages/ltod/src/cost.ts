import type { TokenUsage } from './usage';

/** USD per 1M tokens, as published by the model catalog. */
export interface ModelPrice {
  readonly input: number;
  readonly output: number;
  /** Optional: providers that meter cache reads separately (usually ~0.1×input). */
  readonly cacheRead?: number;
  /** Optional: providers that meter cache writes separately (usually ~1.25×input). */
  readonly cacheWrite?: number;
}

/**
 * Cost of one usage record in USD, or `undefined` when the model has no price.
 *
 * Absence is meaningful: showing `$0.00` for an unpriced model would read as
 * "free", so callers must render a placeholder instead of a number.
 */
export function estimateCost(usage: TokenUsage, price: ModelPrice | undefined): number | undefined {
  if (price === undefined) return undefined;
  const cacheRead = price.cacheRead ?? price.input;
  const cacheWrite = price.cacheWrite ?? price.input;
  return (
    (usage.inputOther * price.input +
      usage.inputCacheRead * cacheRead +
      usage.inputCacheCreation * cacheWrite +
      usage.output * price.output) /
    1_000_000
  );
}

/** Sum of two optional costs; `undefined` only when both sides are unpriced. */
export function addCost(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a + b;
}

/** `$1.2345` with four decimals — sub-cent precision matters for single calls. */
export function formatUsd(cost: number | undefined): string {
  if (cost === undefined) return '—';
  return `$${cost.toFixed(4)}`;
}
