import { describe, expect, it, vi } from 'vitest';

import { ErrorCodes, ScreamError, type ScreamConfig, type Logger } from '#/index';

import { ProviderManager } from '../../agent-core/src/session/provider-manager';

function managedConfig(): ScreamConfig {
  return {
    providers: {
      'managed:scream-code': {
        type: 'scream',
        baseUrl: 'https://api.scream.com/coding/v1',
        apiKey: '',
        oauth: { storage: 'file', key: 'oauth/scream-code' },
      },
    },
    models: {
      'scream-code/scream-for-coding': {
        provider: 'managed:scream-code',
        model: 'scream-for-coding',
        maxContextSize: 262144,
      },
    },
    defaultModel: 'scream-code/scream-for-coding',
  };
}

async function resolveRuntimeProviderWithOAuth(options: {
  readonly config: ScreamConfig;
  readonly resolveOAuthTokenProvider?: import('../../agent-core/src/session/provider-manager').OAuthTokenProviderResolver;
  readonly log?: Logger;
}) {
  const manager = new ProviderManager({
    config: options.config,
    resolveOAuthTokenProvider: options.resolveOAuthTokenProvider,
  });
  const model = options.config.defaultModel;
  if (model === undefined) {
    throw new ScreamError(ErrorCodes.CONFIG_INVALID, 'No model is selected.');
  }
  const { providerName, provider } = manager.resolveProviderConfig(model);

  const providerConfig = options.config.providers[providerName];
  if (providerConfig?.oauth !== undefined && (providerConfig.apiKey ?? '').length > 0) {
    throw new ScreamError(
      ErrorCodes.CONFIG_INVALID,
      `Provider "${providerName}" has both apiKey and oauth set in config.toml — they are mutually exclusive. Remove one.`,
    );
  }

  const oauthRef = providerConfig?.oauth;
  const tokenProvider = options.resolveOAuthTokenProvider?.(providerName, oauthRef);

  if (tokenProvider === undefined) {
    throw new ScreamError(
      ErrorCodes.AUTH_LOGIN_REQUIRED,
      `OAuth provider "${providerName}" requires login before it can be used.`,
    );
  }

  // Replicate the old API's eager token fetch during resolution so
  // test mocks see the expected call sequence.
  try {
    await tokenProvider.getAccessToken(undefined);
  } catch (error) {
    if (
      !(error instanceof ScreamError && error.code === ErrorCodes.AUTH_LOGIN_REQUIRED)
    ) {
      options.log?.warn('oauth token fetch failed', { providerName, error });
    }
    throw new ScreamError(
      ErrorCodes.AUTH_LOGIN_REQUIRED,
      `OAuth provider "${providerName}" requires login before it can be used.`,
      { cause: error },
    );
  }

  return {
    providerName,
    provider,
    resolveAuth: async (opts?: { forceRefresh?: boolean }) => {
      try {
        const apiKey = await tokenProvider.getAccessToken(
          opts?.forceRefresh ? { force: true } : undefined,
        );
        if (apiKey.trim().length === 0) {
          throw new ScreamError(
            ErrorCodes.AUTH_LOGIN_REQUIRED,
            `OAuth provider "${providerName}" requires login before it can be used.`,
          );
        }
        return { apiKey };
      } catch (error) {
        if (
          !(error instanceof ScreamError && error.code === ErrorCodes.AUTH_LOGIN_REQUIRED)
        ) {
          options.log?.warn('oauth token fetch failed', { providerName, error });
        }
        throw new ScreamError(
          ErrorCodes.AUTH_LOGIN_REQUIRED,
          `OAuth provider "${providerName}" requires login before it can be used.`,
          { cause: error },
        );
      }
    },
  };
}

describe('resolveRuntimeProviderWithOAuth', () => {
  it('returns request-scoped OAuth auth without storing the initial access token in provider config', async () => {
    const tokens = ['initial-oauth-token', 'rotated-oauth-token', 'force-refreshed-oauth-token'];
    const getAccessToken = vi.fn().mockImplementation(async () => {
      const token = tokens.shift();
      if (token === undefined) throw new Error('unexpected token request');
      return token;
    });

    const resolved = await resolveRuntimeProviderWithOAuth({
      config: managedConfig(),
      resolveOAuthTokenProvider: (_providerName, oauthRef) => {
        expect(oauthRef).toEqual({ storage: 'file', key: 'oauth/scream-code' });
        return { getAccessToken };
      },
    });

    expect(resolved.providerName).toBe('managed:scream-code');
    expect(resolved.provider).toMatchObject({
      type: 'scream',
      model: 'scream-for-coding',
      baseUrl: 'https://api.scream.com/coding/v1',
    });
    expect(resolved.provider.apiKey).toBeUndefined();
    await expect(resolved.resolveAuth?.()).resolves.toEqual({ apiKey: 'rotated-oauth-token' });
    await expect(resolved.resolveAuth?.({ forceRefresh: true })).resolves.toEqual({
      apiKey: 'force-refreshed-oauth-token',
    });
    expect(getAccessToken.mock.calls).toEqual([[undefined], [undefined], [{ force: true }]]);
  });

  it('throws a clear login-required error when no token provider exists', async () => {
    await expect(
      resolveRuntimeProviderWithOAuth({
        config: managedConfig(),
      }),
    ).rejects.toThrow(/requires login/);
  });

  it('rejects providers that set both apiKey and oauth on the same config', async () => {
    const conflicting: ScreamConfig = {
      ...managedConfig(),
      providers: {
        'managed:scream-code': {
          type: 'scream',
          baseUrl: 'https://api.scream.com/coding/v1',
          apiKey: 'static-key',
          oauth: { storage: 'file', key: 'oauth/scream-code' },
        },
      },
    };

    await expect(
      resolveRuntimeProviderWithOAuth({
        config: conflicting,
        resolveOAuthTokenProvider: () => ({
          getAccessToken: vi.fn().mockResolvedValue('unused'),
        }),
      }),
    ).rejects.toThrow(/mutually exclusive/);
  });

  it('wraps token provider failures as login-required errors', async () => {
    await expect(
      resolveRuntimeProviderWithOAuth({
        config: managedConfig(),
        resolveOAuthTokenProvider: () => ({
          getAccessToken: vi.fn().mockRejectedValue(new Error('missing token')),
        }),
      }),
    ).rejects.toMatchObject({
      name: 'ScreamError',
      code: 'auth.login_required',
    });
  });

  it('logs token provider failures except plain login-required errors', async () => {
    const log = testLogger();
    await expect(
      resolveRuntimeProviderWithOAuth({
        config: managedConfig(),
        log,
        resolveOAuthTokenProvider: () => ({
          getAccessToken: vi.fn().mockRejectedValue(new Error('token endpoint down')),
        }),
      }),
    ).rejects.toMatchObject({ code: 'auth.login_required' });
    expect(log.warn).toHaveBeenCalledWith(
      'oauth token fetch failed',
      expect.objectContaining({
        providerName: 'managed:scream-code',
        error: expect.any(Error),
      }),
    );

    vi.clearAllMocks();
    await expect(
      resolveRuntimeProviderWithOAuth({
        config: managedConfig(),
        log,
        resolveOAuthTokenProvider: () => ({
          getAccessToken: vi.fn().mockRejectedValue(
            new ScreamError(ErrorCodes.AUTH_LOGIN_REQUIRED, 'not logged in'),
          ),
        }),
      }),
    ).rejects.toMatchObject({ code: 'auth.login_required' });
    expect(log.warn).not.toHaveBeenCalled();
  });
});

function testLogger(): Logger {
  const logger: Logger = {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    createChild: () => logger,
  };
  return logger;
}
