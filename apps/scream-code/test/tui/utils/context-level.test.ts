import { describe, expect, it } from 'vitest';

import { contextLevel } from '#/tui/utils/context-level';

describe('contextLevel', () => {
  it('behaves as a plain percentage on 200K and 256K windows', () => {
    for (const window of [200_000, 256_000]) {
      expect(contextLevel(0.59, window)).toBe('normal');
      expect(contextLevel(0.6, window)).toBe('warning');
      expect(contextLevel(0.89, window)).toBe('warning');
      expect(contextLevel(0.9, window)).toBe('error');
    }
  });

  it('trips on absolute tokens first on a 1M window', () => {
    expect(contextLevel(0.39, 1_000_000)).toBe('normal'); // 390K
    expect(contextLevel(0.4, 1_000_000)).toBe('warning'); // 400K
    expect(contextLevel(0.69, 1_000_000)).toBe('warning');
    expect(contextLevel(0.7, 1_000_000)).toBe('error'); // 700K
  });

  it('switches from percentage to tokens where the two thresholds cross', () => {
    // warning: 60% == 400K at a 666,667-token window
    expect(contextLevel(0.6, 600_000)).toBe('warning');
    expect(contextLevel(0.59, 600_000)).toBe('normal');
    expect(contextLevel(0.58, 700_000)).toBe('warning'); // 406K >= 400K
    // error: 90% == 700K at a 777,778-token window
    expect(contextLevel(0.89, 750_000)).toBe('warning'); // 667K: below 700K and below 90%
    expect(contextLevel(0.9, 750_000)).toBe('error'); // 90% (675K) comes before 700K
    expect(contextLevel(0.87, 800_000)).toBe('warning'); // 696K < 700K
    expect(contextLevel(0.88, 800_000)).toBe('error'); // 704K >= 700K, before 90%
  });

  it('uses only the percentage when the window size is unknown', () => {
    expect(contextLevel(0.59, 0)).toBe('normal');
    expect(contextLevel(0.6, 0)).toBe('warning');
    expect(contextLevel(0.9, 0)).toBe('error');
    expect(contextLevel(0.95, Number.NaN)).toBe('error');
  });

  it('treats garbage usage as empty', () => {
    expect(contextLevel(Number.NaN, 1_000_000)).toBe('normal');
    expect(contextLevel(-1, 1_000_000)).toBe('normal');
    expect(contextLevel(Number.POSITIVE_INFINITY, 1_000_000)).toBe('normal');
  });
});
