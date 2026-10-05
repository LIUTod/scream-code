import { APIStatusError } from '@scream-code/ltod';
import { describe, expect, it } from 'vitest';

import type { ScreamConfig } from '../../src/config';
import { ProviderManager, type BearerTokenProvider } from '../../src/session/provider-manager';

/**
 * OAuth request-auth behaviour of `ProviderManager.resolveAuth`: which config
 * shapes count as an ambiguous api-key + oauth entry, and what a forced refresh
 * after a 401 is told about the request that failed.
 */

function oauthConfig(entry: { apiKey?: string; env?: Record<string, string> } = {}): ScreamConfig {
  return {
    defaultModel: 'claude-alias',
    providers: {
      anthropic: {
        type: 'anthropic',
        oauth: { storage: 'file', key: 'anthropic' },
        ...entry,
      },
    },
    models: {
      'claude-alias': {
        provider: 'anthropic',
        model: 'claude-runtime',
        maxContextSize: 200_000,
      },
    },
  };
}

function managerFor(
  config: ScreamConfig,
  tokenProvider: BearerTokenProvider,
): ProviderManager {
  return new ProviderManager({
    config,
    resolveOAuthTokenProvider: () => tokenProvider,
  });
}

const STATIC_TOKEN: BearerTokenProvider = {
  getAccessToken: async () => 'oauth-access-token',
};

describe('ProviderManager api-key/oauth conflict', () => {
  it('does not treat a key inherited from env as a conflicting apiKey', () => {
    const manager = managerFor(
      oauthConfig({ env: { ANTHROPIC_API_KEY: 'sk-from-env' } }),
      STATIC_TOKEN,
    );

    // The message this guard raises points at the `apiKey` field, which does not
    // exist here; the login flow cannot remove an env entry either.
    expect(() => manager.resolveAuth('claude-alias')).not.toThrow();
  });

  it('still rejects a literal apiKey alongside oauth', () => {
    const manager = managerFor(oauthConfig({ apiKey: 'sk-literal' }), STATIC_TOKEN);

    expect(() => manager.resolveAuth('claude-alias')).toThrow(/mutually exclusive/);
  });
});

describe('ProviderManager forced refresh after a 401', () => {
  it('tells the refresh which access token the rejected request used', async () => {
    const calls: Array<{ force?: boolean; rejectedAccess?: string } | undefined> = [];
    const tokenProvider: BearerTokenProvider = {
      getAccessToken: async () => 'rejected-token',
      getRequestAuth: async (options) => {
        calls.push(options);
        const token = options?.force === true ? 'rotated-token' : 'rejected-token';
        return { headers: { Authorization: `Bearer ${token}` } };
      },
    };
    const manager = managerFor(oauthConfig(), tokenProvider);
    const authorized = manager.resolveAuth('claude-alias');
    expect(authorized).toBeDefined();

    let attempts = 0;
    const result = await authorized!(async (auth) => {
      attempts += 1;
      if (attempts === 1) throw new APIStatusError(401, 'unauthorized');
      return auth;
    });

    expect(result).toEqual({ headers: { Authorization: 'Bearer rotated-token' } });
    // The replay authenticates with the rotated token, and the forced refresh
    // knows the token it must consider rejected.
    expect(calls).toEqual([undefined, { force: true, rejectedAccess: 'rejected-token' }]);
  });

  it('reads the rejected token from the plain access-token path as well', async () => {
    const calls: Array<{ force?: boolean; rejectedAccess?: string } | undefined> = [];
    const tokenProvider: BearerTokenProvider = {
      getAccessToken: async (options) => {
        calls.push(options);
        return options?.force === true ? 'rotated-token' : 'rejected-token';
      },
    };
    const manager = managerFor(oauthConfig(), tokenProvider);
    const authorized = manager.resolveAuth('claude-alias');

    let attempts = 0;
    await authorized!(async () => {
      attempts += 1;
      if (attempts === 1) throw new APIStatusError(401, 'unauthorized');
      return undefined;
    });

    expect(calls).toEqual([undefined, { force: true, rejectedAccess: 'rejected-token' }]);
  });

  it('unwraps the token from a structured JSON credential before forcing a refresh', async () => {
    const calls: Array<{ force?: boolean; rejectedAccess?: string } | undefined> = [];
    // Mirrors the credential store: a forced refresh only runs while the token
    // it was rejected with is still the stored one. Handing it the whole JSON
    // blob instead of the bare token would always skip the refresh and the
    // replay would authenticate with the rejected token again.
    const stored = { access: 'T1' };
    let rotations = 0;
    const tokenProvider: BearerTokenProvider = {
      getAccessToken: async () => stored.access,
      getRequestAuth: async (options) => {
        calls.push(options);
        if (options?.force === true && options.rejectedAccess === stored.access) {
          stored.access = 'T2';
          rotations += 1;
        }
        return { apiKey: JSON.stringify({ token: stored.access, accountId: 'A' }) };
      },
    };
    const manager = managerFor(oauthConfig(), tokenProvider);
    const authorized = manager.resolveAuth('claude-alias');

    let attempts = 0;
    const result = await authorized!(async (auth) => {
      attempts += 1;
      if (attempts === 1) throw new APIStatusError(401, 'unauthorized');
      return auth;
    });

    expect(rotations).toBe(1);
    expect(result).toEqual({ apiKey: JSON.stringify({ token: 'T2', accountId: 'A' }) });
    expect(calls).toEqual([undefined, { force: true, rejectedAccess: 'T1' }]);
  });

  it('skips the rotation when a structured credential was already rotated', async () => {
    const calls: Array<{ force?: boolean; rejectedAccess?: string } | undefined> = [];
    const stored = { access: 'T1' };
    let rotations = 0;
    const tokenProvider: BearerTokenProvider = {
      getAccessToken: async () => stored.access,
      getRequestAuth: async (options) => {
        calls.push(options);
        if (options?.force === true && options.rejectedAccess === stored.access) {
          stored.access = 'T2';
          rotations += 1;
        }
        return { apiKey: JSON.stringify({ token: stored.access, accountId: 'A' }) };
      },
    };
    const manager = managerFor(oauthConfig(), tokenProvider);
    const authorized = manager.resolveAuth('claude-alias');

    let attempts = 0;
    await authorized!(async (auth) => {
      attempts += 1;
      if (attempts === 1) {
        // Another request rotated the credential while this one was in flight.
        stored.access = 'T2';
        throw new APIStatusError(401, 'unauthorized');
      }
      return auth;
    });

    expect(rotations).toBe(0);
    expect(calls).toEqual([undefined, { force: true, rejectedAccess: 'T1' }]);
  });

  it('reads aliased token fields in the order the request layer reads them', async () => {
    const calls: Array<{ force?: boolean; rejectedAccess?: string } | undefined> = [];
    const stored = { access: 'from-access-token' };
    let rotations = 0;
    const tokenProvider: BearerTokenProvider = {
      getAccessToken: async () => stored.access,
      getRequestAuth: async (options) => {
        calls.push(options);
        if (options?.force === true && options.rejectedAccess === stored.access) {
          stored.access = 'rotated';
          rotations += 1;
        }
        // Both spellings are present with different values. The request layer
        // resolves `access_token` before `access`, so that is the token on the
        // wire and the one the guard has to compare against.
        return {
          apiKey: JSON.stringify({ access: 'from-access', access_token: stored.access }),
        };
      },
    };
    const manager = managerFor(oauthConfig(), tokenProvider);
    const authorized = manager.resolveAuth('claude-alias');

    let attempts = 0;
    await authorized!(async (auth) => {
      attempts += 1;
      if (attempts === 1) throw new APIStatusError(401, 'unauthorized');
      return auth;
    });

    expect(rotations).toBe(1);
    expect(calls).toEqual([undefined, { force: true, rejectedAccess: 'from-access-token' }]);
  });
});
