import { mkdtemp, rm } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OAuthLoginService } from '../../src/auth-oauth/index';
import { FileOAuthCredentialStore } from '../../src/auth-oauth/store';
import type { OAuthCredential, OAuthProviderModule } from '../../src/auth-oauth/types';

/**
 * Extra registry entries used to exercise `getRequestAuth` fallbacks that no
 * shipped provider hits: a module without `toAuth`, and one whose `toAuth`
 * yields nothing usable.
 */
vi.mock('../../src/auth-oauth/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/auth-oauth/registry')>();
  const credential = (): OAuthCredential => ({
    type: 'oauth',
    access: 'fallback-access',
    refresh: 'refresh-token',
    expires: Date.now() + 60 * 60 * 1000,
  });
  const extras = {
    'legacy-provider': {
      id: 'legacy-provider',
      name: 'Legacy provider (no toAuth)',
      login: async () => credential(),
      refresh: async (stored: OAuthCredential) => stored,
    },
    'empty-auth-provider': {
      id: 'empty-auth-provider',
      name: 'Provider with an empty toAuth',
      login: async () => credential(),
      refresh: async (stored: OAuthCredential) => stored,
      toAuth: () => ({}),
    },
    'shaped-provider': {
      id: 'shaped-provider',
      name: 'Provider with request auth',
      login: async () => credential(),
      refresh: async (stored: OAuthCredential) => stored,
      toAuth: (stored: OAuthCredential) => ({
        apiKey: stored.access,
        baseUrl: 'https://shaped.example/v1',
      }),
    },
  } satisfies Record<string, OAuthProviderModule>;
  return {
    ...actual,
    findOAuthProvider: (id: string) =>
      extras[id as keyof typeof extras] ?? actual.findOAuthProvider(id),
  };
});

const HOUR_MS = 60 * 60 * 1000;

function credential(access: string): OAuthCredential {
  return {
    type: 'oauth',
    access,
    refresh: 'refresh-token',
    expires: Date.now() + HOUR_MS,
  };
}

describe('OAuthLoginService', () => {
  let homeDir: string;
  let service: OAuthLoginService;
  let store: FileOAuthCredentialStore;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'oauth-service-'));
    service = new OAuthLoginService({ homeDir });
    store = new FileOAuthCredentialStore(join(homeDir, 'oauth'));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(homeDir, { recursive: true, force: true });
  });

  it('lists every registered provider with selector metadata', () => {
    const providers = service.listProviders();
    expect(providers.map((provider) => provider.id)).toEqual([
      'anthropic',
      'openai-chatgpt',
      'openai-codex',
      'github-copilot',
      'google-antigravity',
      'google-gemini-cli',
      'openrouter',
      'xai',
      'kimi-coding',
      'meta',
      'radius',
    ]);
    for (const provider of providers) {
      expect(provider.name.length).toBeGreaterThan(0);
    }
  });

  it('stores credentials under <homeDir>/oauth with 0600 permissions', () => {
    store.write('openrouter', credential('openrouter-access'));
    expect(service.hasCredential('openrouter')).toBe(true);
    expect(service.getCachedAccessToken('openrouter')).toBe('openrouter-access');
    const mode = statSync(join(homeDir, 'oauth', 'openrouter.json')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('resolves bearer tokens for stored credentials and leaves unknown ids alone', async () => {
    store.write('openrouter', credential('openrouter-access'));
    const tokenProvider = service.resolveTokenProvider('openrouter');
    expect(tokenProvider).toBeDefined();
    await expect(tokenProvider!.getAccessToken()).resolves.toBe('openrouter-access');

    expect(service.resolveTokenProvider('unknown-provider')).toBeUndefined();
  });

  it('derives request auth from the stored credential via the provider toAuth', async () => {
    store.write('openrouter', credential('openrouter-access'));
    const openrouter = service.resolveTokenProvider('openrouter');
    await expect(openrouter!.getRequestAuth!()).resolves.toEqual({
      apiKey: 'openrouter-access',
      baseUrl: 'https://openrouter.ai/api/v1',
    });

    store.write('anthropic', credential('anthropic-access'));
    const anthropic = service.resolveTokenProvider('anthropic');
    await expect(anthropic!.getRequestAuth!()).resolves.toEqual({
      headers: { Authorization: 'Bearer anthropic-access' },
    });
  });

  it('refreshes the credential before deriving request auth when forced', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              access_token: 'fresh-access',
              refresh_token: 'fresh-refresh',
              expires_in: 3600,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
      ),
    );
    store.write('xai', {
      type: 'oauth',
      access: 'stale-access',
      refresh: 'refresh-token',
      expires: 0,
    });

    const xai = service.resolveTokenProvider('xai');
    await expect(xai!.getRequestAuth!({ force: true })).resolves.toEqual({
      apiKey: 'fresh-access',
      baseUrl: 'https://api.x.ai/v1',
    });
    await expect(xai!.getAccessToken()).resolves.toBe('fresh-access');
  });

  it('falls back to the bearer token when the provider has no toAuth', async () => {
    store.write('legacy-provider', credential('fallback-access'));
    const tokenProvider = service.resolveTokenProvider('legacy-provider');
    await expect(tokenProvider!.getRequestAuth!()).resolves.toEqual({
      apiKey: 'fallback-access',
    });
  });

  it('falls back to the bearer token when toAuth yields no usable auth', async () => {
    store.write('empty-auth-provider', credential('fallback-access'));
    const tokenProvider = service.resolveTokenProvider('empty-auth-provider');
    await expect(tokenProvider!.getRequestAuth!()).resolves.toEqual({
      apiKey: 'fallback-access',
    });
  });

  it('returns the provider request auth from login', async () => {
    const interaction = {
      signal: new AbortController().signal,
      prompt: async () => '',
      notify: () => undefined,
    };

    await expect(service.login('shaped-provider', interaction)).resolves.toMatchObject({
      providerId: 'shaped-provider',
      requestAuth: { apiKey: 'fallback-access', baseUrl: 'https://shaped.example/v1' },
    });

    const legacy = await service.login('legacy-provider', interaction);
    expect(legacy.requestAuth).toBeUndefined();
  });

  it('rejects token resolution with a login-required error when signed out', async () => {
    store.write('openrouter', credential('openrouter-access'));
    const tokenProvider = service.resolveTokenProvider('openrouter');
    service.logout('openrouter');
    expect(service.hasCredential('openrouter')).toBe(false);
    await expect(tokenProvider!.getAccessToken()).rejects.toThrow('requires login');
  });

  it('resolves the credential through the recorded oauth key when the entry is renamed', async () => {
    // A renamed or copied provider entry still records the credential key the
    // sign-in wrote; looking up only the config key would miss the file.
    store.write('anthropic', credential('anthropic-access'));
    const renamed = service.resolveTokenProvider('anthropic-work', {
      storage: 'file',
      key: 'anthropic',
    });
    expect(renamed).toBeDefined();
    await expect(renamed!.getAccessToken()).resolves.toBe('anthropic-access');
    await expect(renamed!.getRequestAuth!()).resolves.toEqual({
      headers: { Authorization: 'Bearer anthropic-access' },
    });

    // Without the reference the config key is used, and a key that names no
    // module resolves no token provider at all.
    expect(service.resolveTokenProvider('anthropic-work')).toBeUndefined();
  });

  it('falls back to the config key when the recorded oauth key names no module', async () => {
    store.write('openrouter', credential('openrouter-access'));
    const provider = service.resolveTokenProvider('openrouter', {
      storage: 'file',
      key: 'not-a-provider',
    });
    expect(provider).toBeDefined();
    await expect(provider!.getAccessToken()).resolves.toBe('openrouter-access');
  });

  it('rejects logins for provider ids outside the registry', async () => {
    const interaction = {
      signal: new AbortController().signal,
      prompt: async () => '',
      notify: () => undefined,
    };
    await expect(service.login('not-a-provider', interaction)).rejects.toThrow(
      'Unknown OAuth provider',
    );
  });
});
