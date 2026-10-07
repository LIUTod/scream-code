/**
 * api-balance cache bounding: expired entries must disappear and the map
 * must respect its capacity cap.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const providers = new Map<string, { baseUrl: string; apiKey: string; type: string }>();
  return {
    providers,
    fetchProviderBalance: vi.fn(async () => ({ total: 1, currency: 'USD' })),
    reset() {
      providers.clear();
      mocks.fetchProviderBalance.mockClear();
    },
  };
});

vi.mock('@scream-code/scream-code-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@scream-code/scream-code-sdk')>();
  return {
    ...actual,
    readConfigFile: () => ({ providers: Object.fromEntries(mocks.providers) }),
    fetchProviderBalance: mocks.fetchProviderBalance,
    isSupportedBalanceProvider: () => true,
  };
});

vi.mock('@/tui/utils/paths', () => ({
  getDataDir: () => '/tmp/api-balance-test',
}));

async function importApiBalance() {
  return import('@/tui/api-balance');
}

describe('api-balance cache bounds', () => {
  let api: Awaited<ReturnType<typeof importApiBalance>>;

  beforeEach(async () => {
    mocks.reset();
    vi.useFakeTimers();
    vi.setSystemTime(0);
    api = await importApiBalance();
    api.invalidateBalanceCache();
  });

  afterEach(() => {
    api.invalidateBalanceCache();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function registerProvider(name: string): void {
    mocks.providers.set(name, {
      baseUrl: `https://${name}.example.com`,
      apiKey: `key-${name}`,
      type: 'openai',
    });
  }

  it('deletes an expired entry on re-lookup instead of leaving it behind', async () => {
    registerProvider('p0');
    const deleteSpy = vi.spyOn(Map.prototype, 'delete');

    await api.getProviderBalanceForModel('p0/model-a');
    expect(mocks.fetchProviderBalance).toHaveBeenCalledTimes(1);

    // Within TTL: served from cache.
    vi.advanceTimersByTime(30_000);
    await api.getProviderBalanceForModel('p0/model-a');
    expect(mocks.fetchProviderBalance).toHaveBeenCalledTimes(1);

    // Past TTL: the stale entry must be deleted before the refetch lands.
    vi.advanceTimersByTime(31_000);
    await api.getProviderBalanceForModel('p0/model-a');
    expect(mocks.fetchProviderBalance).toHaveBeenCalledTimes(2);
    expect(deleteSpy).toHaveBeenCalledWith('p0');
    deleteSpy.mockRestore();
  });

  it('prunes other expired entries when a new provider is inserted', async () => {
    registerProvider('p_old');
    registerProvider('p_new');
    const deleteSpy = vi.spyOn(Map.prototype, 'delete');

    await api.getProviderBalanceForModel('p_old/model');
    vi.advanceTimersByTime(61_000); // p_old now expired
    await api.getProviderBalanceForModel('p_new/model');

    expect(deleteSpy).toHaveBeenCalledWith('p_old');
    deleteSpy.mockRestore();
  });

  it('caps the cache at 32 entries, evicting the oldest', async () => {
    for (let i = 0; i < 33; i++) {
      registerProvider(`p${String(i)}`);
    }

    for (let i = 0; i < 33; i++) {
      await api.getProviderBalanceForModel(`p${String(i)}/m`);
    }
    // 33 distinct providers, 33 fetches so far; the map is capped at 32.
    expect(mocks.fetchProviderBalance).toHaveBeenCalledTimes(33);

    // p0 is the oldest and must have been evicted → refetch.
    await api.getProviderBalanceForModel('p0/m');
    expect(mocks.fetchProviderBalance).toHaveBeenCalledTimes(34);

    // p32 is the newest and must still be cached → no refetch.
    await api.getProviderBalanceForModel('p32/m');
    expect(mocks.fetchProviderBalance).toHaveBeenCalledTimes(34);
  });

  it('keeps serving a fresh entry from cache without refetching', async () => {
    registerProvider('p0');
    await api.getProviderBalanceForModel('p0/m');
    await api.getProviderBalanceForModel('p0/m');
    expect(mocks.fetchProviderBalance).toHaveBeenCalledTimes(1);
  });
});
