import { describe, expect, it } from 'vitest';

import { DEFAULT_DEDUP_TTL_MS, MessageDedup } from '#/line/dedup';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('MessageDedup (port of cc-connect core/dedup.go)', () => {
  it('drops the same message id within the TTL window', () => {
    const dedup = new MessageDedup();
    expect(dedup.isDuplicate('om_1')).toBe(false);
    expect(dedup.isDuplicate('om_1')).toBe(true);
    expect(dedup.isDuplicate('om_2')).toBe(false);
  });

  it('never treats an empty id as a duplicate', () => {
    const dedup = new MessageDedup();
    expect(dedup.isDuplicate('')).toBe(false);
    expect(dedup.isDuplicate('')).toBe(false);
    expect(dedup.size()).toBe(0);
  });

  it('expires entries after the TTL so later sends pass again', async () => {
    const dedup = new MessageDedup(10);
    expect(dedup.isDuplicate('om_x')).toBe(false);
    expect(dedup.isDuplicate('om_x')).toBe(true);
    await sleep(25);
    expect(dedup.isDuplicate('om_x')).toBe(false);
  });

  it('bounds the tracked set by pruning expired entries', async () => {
    const dedup = new MessageDedup(10);
    for (let i = 0; i < 50; i++) dedup.isDuplicate(`om_${i}`);
    expect(dedup.size()).toBe(50);
    await sleep(25);
    expect(dedup.size()).toBe(0);
  });

  it('falls back to the default TTL for non-positive values', () => {
    expect(new MessageDedup(0).isDuplicate('a')).toBe(false);
    expect(DEFAULT_DEDUP_TTL_MS).toBe(60_000);
  });
});
