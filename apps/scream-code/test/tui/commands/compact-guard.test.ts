import { getLocale, setLocale, t } from '@scream-code/config';
import { describe, expect, it, vi } from 'vitest';

import { handleCompactCommand, shouldGuardCompaction, showModelPicker } from '#/tui/commands/config';

import { makeMockSession, makeMockSlashCommandHost } from '../fixtures/mock-host';

async function inLocale<T>(locale: 'en' | 'zh', fn: () => Promise<T>): Promise<T> {
  const previous = getLocale();
  setLocale(locale);
  try {
    return await fn();
  } finally {
    setLocale(previous);
  }
}

interface GuardState {
  contextTokens: number;
  maxContextTokens: number;
}

function makeState(overrides: Partial<GuardState> = {}): GuardState {
  return {
    contextTokens: 0,
    maxContextTokens: 200_000,
    ...overrides,
  };
}

describe('shouldGuardCompaction (Storm Breaker /compact guard)', () => {
  it('returns null when maxContextTokens is unknown (<= 0)', () => {
    expect(shouldGuardCompaction(makeState({ maxContextTokens: 0 }))).toBeNull();
    expect(shouldGuardCompaction(makeState({ maxContextTokens: -1 }))).toBeNull();
  });

  it('returns null when contextTokens is zero (no session content yet)', () => {
    expect(shouldGuardCompaction(makeState({ contextTokens: 0 }))).toBeNull();
  });

  it('returns guard info when context is below 5% of the window', () => {
    const state = makeState({ contextTokens: 5_000, maxContextTokens: 200_000 }); // 2.5%
    const guard = shouldGuardCompaction(state);
    expect(guard).not.toBeNull();
    expect(guard!.currentTokens).toBe(5_000);
    expect(guard!.maxContextTokens).toBe(200_000);
    expect(guard!.ratio).toBeCloseTo(0.025, 5);
  });

  it('returns null at exactly 5% (boundary — compression is legitimate)', () => {
    const state = makeState({ contextTokens: 10_000, maxContextTokens: 200_000 }); // 5%
    expect(shouldGuardCompaction(state)).toBeNull();
  });

  it('returns null when context is at 20%', () => {
    const state = makeState({ contextTokens: 40_000, maxContextTokens: 200_000 }); // 20%
    expect(shouldGuardCompaction(state)).toBeNull();
  });

  it('returns null when context is well above 20%', () => {
    const state = makeState({ contextTokens: 150_000, maxContextTokens: 200_000 }); // 75%
    expect(shouldGuardCompaction(state)).toBeNull();
  });

  it('guards when context is tiny relative to a small window', () => {
    const state = makeState({ contextTokens: 100, maxContextTokens: 8_000 }); // 1.25%
    const guard = shouldGuardCompaction(state);
    expect(guard).not.toBeNull();
    expect(guard!.ratio).toBeCloseTo(0.0125, 5);
  });
});

describe('/compact guard notice', () => {
  const SMALL_CONTEXT = { contextTokens: 5_000, maxContextTokens: 200_000 } as const; // 2.5%

  it.each(['zh', 'en'] as const)('explains in the UI language why compaction is refused (%s)', async (locale) => {
    const compact = vi.fn(async (): Promise<void> => {});
    const host = makeMockSlashCommandHost({
      session: makeMockSession({ overrides: { compact } }),
      appState: SMALL_CONTEXT,
    });

    await inLocale(locale, () => handleCompactCommand(host, ''));

    expect(compact).not.toHaveBeenCalled();
    const [title, detail] = vi.mocked(host.showNotice).mock.calls[0] ?? [];
    expect(title).toBe(await inLocale(locale, async () => t('handler.storm_breaker_title')));
    expect(detail).toContain('5.0k');
    expect(detail).toContain('200.0k');
    expect(detail).toContain('2.5%');
    expect(detail).toContain('/compact');
    if (locale === 'en') expect(detail).toContain('compaction would gain nothing');
    else expect(detail).toContain('压缩无收益');
  });

  it('compacts normally once the context is large enough', async () => {
    const compact = vi.fn(async (): Promise<void> => {});
    const host = makeMockSlashCommandHost({
      session: makeMockSession({ overrides: { compact } }),
      appState: { contextTokens: 50_000, maxContextTokens: 200_000 },
    });

    await handleCompactCommand(host, 'keep the schema');

    expect(compact).toHaveBeenCalledWith({ instruction: 'keep the schema' });
    expect(host.showNotice).not.toHaveBeenCalled();
  });
});

describe('model picker with no models configured', () => {
  it.each(['zh', 'en'] as const)('points at /config in the UI language (%s)', async (locale) => {
    const host = makeMockSlashCommandHost({ appState: { availableModels: {} } });

    await inLocale(locale, () => showModelPicker(host));

    const [title, detail] = vi.mocked(host.showNotice).mock.calls[0] ?? [];
    expect(title).toBe(await inLocale(locale, async () => t('model.picker_empty_title')));
    expect(detail).toContain('/config');
    expect(host.mountEditorReplacement).not.toHaveBeenCalled();
    if (locale === 'en') expect(`${title} ${detail}`).not.toMatch(/[\u4E00-\u9FFF]/);
  });
});
