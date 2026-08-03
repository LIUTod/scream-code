/**
 * Provider account-balance lookup.
 *
 * Only official vendor endpoints are recognized; any other base URL (for
 * example a gateway that happens to be named after a vendor) returns null
 * and the caller simply hides the balance. New providers are added by
 * appending a fetcher to the registry — no other code changes.
 *
 * The apiKey passed in is the runtime-resolved plaintext key; this module
 * never reads configuration files itself.
 */

export interface ProviderBalance {
  /** Currency code as reported by the vendor, e.g. "CNY". */
  currency: string;
  /** Total balance as a string, e.g. "110.00". */
  totalBalance: string;
}

interface BalanceFetcher {
  /** True when this fetcher owns the given base URL. */
  matches(baseUrl: string): boolean;
  /** Returns the balance, or null when the account/endpoint is unusable. */
  fetch(baseUrl: string, apiKey: string): Promise<ProviderBalance | null>;
}

// ── Provider registry: append a fetcher per vendor ──────────────────────

const deepseekFetcher: BalanceFetcher = {
  matches: (baseUrl) => {
    // Exact hostname match — a substring check would accept lookalike
    // hosts (e.g. api.deepseek.com.evil.com) and leak the bearer key.
    try {
      return new URL(baseUrl).hostname === 'api.deepseek.com';
    } catch {
      return false;
    }
  },
  fetch: async (baseUrl, apiKey) => {
    try {
      // The balance endpoint always lives at the host root regardless of
      // the compat mode baked into base_url (/v1, /anthropic, or bare):
      // origin normalizes them all to https://api.deepseek.com.
      const root = new URL(baseUrl).origin;
      const res = await fetch(`${root}/user/balance`, {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        // Bail out instead of hanging forever on a stalled connection.
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as {
        balance_infos?: Array<{ currency?: string; total_balance?: string }>;
      };
      const info = data.balance_infos?.[0];
      if (info?.total_balance === undefined) return null;
      return {
        currency: info.currency ?? '',
        totalBalance: info.total_balance,
      };
    } catch {
      return null; // network/parse/timeout errors are surfaced as "no balance"
    }
  },
};

const kimiFetcher: BalanceFetcher = {
  matches: (baseUrl) => {
    try {
      // 国内站生产端点; the international platform issues independent
      // keys and its balance endpoint is not documented, so it stays
      // unmatched and silently hides the badge.
      return new URL(baseUrl).hostname === 'api.moonshot.cn';
    } catch {
      return false;
    }
  },
  fetch: async (baseUrl, apiKey) => {
    try {
      // Kimi documents /v1/users/me/balance; the OpenAI-compat base_url
      // may or may not already carry the /v1 prefix, so anchor at origin.
      const root = new URL(baseUrl).origin;
      const res = await fetch(`${root}/v1/users/me/balance`, {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as {
        code?: number;
        data?: { available_balance?: number };
      };
      // available_balance is a float in CNY; failures/missing fields → null.
      if (typeof data.data?.available_balance !== 'number') return null;
      return {
        currency: 'CNY',
        totalBalance: data.data.available_balance.toFixed(2),
      };
    } catch {
      return null;
    }
  },
};

const fetchers: BalanceFetcher[] = [deepseekFetcher, kimiFetcher];

/**
 * Look up the balance for the given provider endpoint.
 * Returns null when the endpoint is not a recognized official vendor or
 * when the lookup fails — callers render nothing in that case.
 */
export async function fetchProviderBalance(
  baseUrl: string,
  apiKey: string,
): Promise<ProviderBalance | null> {
  const fetcher = fetchers.find((f) => f.matches(baseUrl));
  if (!fetcher) return null;
  return fetcher.fetch(baseUrl, apiKey);
}
