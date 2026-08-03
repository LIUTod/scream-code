import { test, describe, expect, vi, afterEach } from 'vitest';
import { fetchProviderBalance, isSupportedBalanceProvider } from '../../src/session/provider-balance';

const originalFetch = globalThis.fetch;

function mockFetchOnce(response: unknown, ok = true): void {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok,
    json: async () => response,
  }) as unknown as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('fetchProviderBalance', () => {
  test('returns null for non-official endpoints', async () => {
    const result = await fetchProviderBalance('https://gateway.example.com', 'sk-x');
    expect(result).toBeNull();
    // The lookup is skipped entirely for unrecognized endpoints.
    expect(vi.isMockFunction(globalThis.fetch)).toBe(false);
  });

  test('rejects lookalike hosts so the bearer key is never leaked', async () => {
    for (const baseUrl of [
      'https://api.deepseek.com.evil.com',
      'https://notapi.deepseek.com',
      'https://gateway.example.com/api.deepseek.com',
    ]) {
      const result = await fetchProviderBalance(baseUrl, 'sk-secret');
      expect(result).toBeNull();
      expect(vi.isMockFunction(globalThis.fetch)).toBe(false);
    }
  });

  test('isSupportedBalanceProvider only accepts official endpoints locally', () => {
    expect(isSupportedBalanceProvider('https://api.deepseek.com')).toBe(true);
    expect(isSupportedBalanceProvider('https://api.deepseek.com/anthropic')).toBe(true);
    expect(isSupportedBalanceProvider('https://api.moonshot.cn')).toBe(true);
    expect(isSupportedBalanceProvider('https://api.moonshot.cn/v1')).toBe(true);
    expect(isSupportedBalanceProvider('https://api.deepseek.com.evil.com')).toBe(false);
    expect(isSupportedBalanceProvider('https://gateway.example.com')).toBe(false);
    expect(isSupportedBalanceProvider('not a url')).toBe(false);
  });

  test('queries the DeepSeek balance endpoint and parses the first info entry', async () => {
    mockFetchOnce({
      is_available: true,
      balance_infos: [
        { currency: 'CNY', total_balance: '110.00', granted_balance: '10.00' },
      ],
    });
    const result = await fetchProviderBalance('https://api.deepseek.com', 'sk-test');
    expect(result).toEqual({ currency: 'CNY', totalBalance: '110.00' });
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(call?.[0])).toBe('https://api.deepseek.com/user/balance');
    expect((call?.[1] as RequestInit | undefined)?.headers).toMatchObject({
      Accept: 'application/json',
      Authorization: 'Bearer sk-test',
    });
  });

  test('normalizes compat-mode base URLs to the host-root balance path', async () => {
    for (const baseUrl of [
      'https://api.deepseek.com',
      'https://api.deepseek.com/v1',
      'https://api.deepseek.com/anthropic',
      'https://api.deepseek.com/',
    ]) {
      mockFetchOnce({ balance_infos: [{ currency: 'CNY', total_balance: '5.00' }] });
      await fetchProviderBalance(baseUrl, 'sk-test');
      const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
      const call = calls.at(-1);
      expect(String(call?.[0])).toBe('https://api.deepseek.com/user/balance');
    }
  });

  test('queries the Kimi balance endpoint and formats the available balance', async () => {
    mockFetchOnce({
      code: 0,
      data: { available_balance: 49.58894, voucher_balance: 46.58893, cash_balance: 3.00001 },
      scode: '0x0',
      status: true,
    });
    const result = await fetchProviderBalance('https://api.moonshot.cn', 'sk-kimi');
    expect(result).toEqual({ currency: 'CNY', totalBalance: '49.59' });
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(call?.[0])).toBe('https://api.moonshot.cn/v1/users/me/balance');
    expect((call?.[1] as RequestInit | undefined)?.headers).toMatchObject({ Authorization: 'Bearer sk-kimi' });
  });

  test('anchors the Kimi /v1 path at the origin even when base_url already has /v1', async () => {
    mockFetchOnce({ data: { available_balance: 1.234 } });
    await fetchProviderBalance('https://api.moonshot.cn/v1', 'sk-kimi');
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(call?.[0])).toBe('https://api.moonshot.cn/v1/users/me/balance');
  });

  test('returns null when the Kimi payload lacks an available balance', async () => {
    mockFetchOnce({ code: 0, data: {}, scode: '0x0', status: true });
    const result = await fetchProviderBalance('https://api.moonshot.cn', 'sk-kimi');
    expect(result).toBeNull();
  });

  test('returns null when the endpoint reports an error status', async () => {
    mockFetchOnce({}, false);
    const result = await fetchProviderBalance('https://api.deepseek.com', 'sk-bad');
    expect(result).toBeNull();
  });

  test('returns null when the payload lacks balance info', async () => {
    mockFetchOnce({ is_available: false });
    const result = await fetchProviderBalance('https://api.deepseek.com', 'sk-x');
    expect(result).toBeNull();
  });

  test('returns null when the request throws', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network down')) as unknown as typeof fetch;
    const result = await fetchProviderBalance('https://api.deepseek.com', 'sk-x');
    expect(result).toBeNull();
  });
});
