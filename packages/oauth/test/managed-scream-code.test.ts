import { describe, expect, it, vi } from 'vitest';

import {
  applyManagedScreamCodeLogoutConfig,
  applyManagedScreamCodeConfig,
  clearManagedScreamCodeConfig,
  fetchManagedScreamCodeModels,
  SCREAM_CODE_PROVIDER_NAME,
  provisionManagedScreamCodeConfig,
  type ManagedScreamConfigShape,
} from '../src/managed-scream-code';

function makeModelsResponse(): Response {
  return new Response(
    JSON.stringify({
      data: [
        {
          id: 'scream-for-coding',
          context_length: 262144,
          supports_reasoning: true,
          supports_image_in: true,
          supports_video_in: true,
          display_name: 'Scream for Coding',
        },
        {
          id: 'scream-k2.5',
          context_length: 250000,
          supports_reasoning: false,
          supports_image_in: false,
          supports_video_in: false,
          supports_tool_use: false,
        },
      ],
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

describe('provisionManagedScreamCodeConfig', () => {
  it('writes the managed provider, models, services, and default model through an adapter', async () => {
    const config: ManagedScreamConfigShape = {
      providers: {
        custom: {
          type: 'scream',
          apiKey: 'sk-existing',
          baseUrl: 'https://example.test/v1',
        },
      },
      models: {
        'scream-code/stale': {
          provider: SCREAM_CODE_PROVIDER_NAME,
          model: 'stale',
        },
        'custom-default': {
          provider: 'custom',
          model: 'custom-model',
        },
      },
    };
    const write = vi.fn();
    const fetchMock = vi.fn(async () => makeModelsResponse());

    const result = await provisionManagedScreamCodeConfig({
      accessToken: 'oauth-access-token',
      fetchImpl: fetchMock as unknown as typeof fetch,
      adapter: {
        configPath: '/tmp/config.toml',
        read: () => config,
        write,
        apply: applyManagedScreamCodeConfig,
      },
    });

    expect(result).toMatchObject({
      providerName: SCREAM_CODE_PROVIDER_NAME,
      defaultModel: 'scream-code/scream-for-coding',
      defaultThinking: true,
      configPath: '/tmp/config.toml',
    });
    expect(result.models[0]?.supportsToolUse).toBe(true);
    expect(result.models[1]?.supportsToolUse).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.scream.com/coding/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer oauth-access-token',
          Accept: 'application/json',
        }),
      }),
    );
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit?][];
    const init = calls[0]?.[1] ?? {};
    const headers = new Headers((init.headers ?? {}) as Record<string, string>);
    expect(headers.get('user-agent')).toBeNull();
    expect(headers.get('x-msh-platform')).toBeNull();
    expect(write).toHaveBeenCalledWith(config);

    expect(config.providers['custom']).toMatchObject({
      apiKey: 'sk-existing',
    });
    expect(config.models?.['custom-default']?.provider).toBe('custom');
    expect(config.models?.['scream-code/stale']).toBeUndefined();
    expect(config.providers[SCREAM_CODE_PROVIDER_NAME]).toMatchObject({
      type: 'scream',
      baseUrl: 'https://api.scream.com/coding/v1',
      apiKey: '',
      oauth: { storage: 'file', key: 'oauth/scream-code' },
    });
    expect(config.models?.['scream-code/scream-for-coding']).toMatchObject({
      provider: SCREAM_CODE_PROVIDER_NAME,
      model: 'scream-for-coding',
      maxContextSize: 262144,
      capabilities: ['thinking', 'image_in', 'video_in', 'tool_use'],
      displayName: 'Scream for Coding',
    });
    expect(config.models?.['scream-code/scream-k2.5']?.capabilities).toBeUndefined();
    expect(config.services?.screamCliSearch).toMatchObject({
      baseUrl: 'https://api.scream.com/coding/v1/search',
      apiKey: '',
      oauth: { storage: 'file', key: 'oauth/scream-code' },
    });
    expect(Object.keys(config.services ?? {})).toEqual(['screamCliSearch', 'screamCliFetch']);
  });

  it('preserves an existing valid default model during refresh', async () => {
    const config: ManagedScreamConfigShape = {
      providers: {
        custom: {
          type: 'scream',
          apiKey: 'sk-existing',
          baseUrl: 'https://example.test/v1',
        },
        [SCREAM_CODE_PROVIDER_NAME]: {
          type: 'scream',
          apiKey: '',
        },
      },
      defaultModel: 'custom-default',
      defaultThinking: false,
      models: {
        'custom-default': {
          provider: 'custom',
          model: 'custom-model',
          maxContextSize: 1000,
        },
        'scream-code/stale': {
          provider: SCREAM_CODE_PROVIDER_NAME,
          model: 'stale',
          maxContextSize: 1000,
        },
      },
    };

    const result = await provisionManagedScreamCodeConfig({
      accessToken: 'oauth-access-token',
      fetchImpl: vi.fn(async () => makeModelsResponse()) as unknown as typeof fetch,
      preserveDefaultModel: true,
      adapter: {
        read: () => config,
        write: vi.fn(),
        apply: applyManagedScreamCodeConfig,
      },
    });

    expect(result.defaultModel).toBe('custom-default');
    expect(result.defaultThinking).toBe(false);
    expect(config.defaultModel).toBe('custom-default');
    expect(config.defaultThinking).toBe(false);
    expect(config.models?.['scream-code/stale']).toBeUndefined();
    expect(config.models?.['scream-code/scream-for-coding']?.displayName).toBe('Scream for Coding');
  });

  it('infers default_thinking from fresh managed model capabilities', async () => {
    const config: ManagedScreamConfigShape = {
      providers: {
        [SCREAM_CODE_PROVIDER_NAME]: {
          type: 'scream',
          apiKey: '',
        },
      },
      defaultModel: 'scream-code/scream-for-coding',
      models: {
        'scream-code/scream-for-coding': {
          provider: SCREAM_CODE_PROVIDER_NAME,
          model: 'scream-for-coding',
          maxContextSize: 1000,
          capabilities: [],
        },
      },
    };

    const result = await provisionManagedScreamCodeConfig({
      accessToken: 'oauth-access-token',
      fetchImpl: vi.fn(async () => makeModelsResponse()) as unknown as typeof fetch,
      preserveDefaultModel: true,
      adapter: {
        read: () => config,
        write: vi.fn(),
        apply: applyManagedScreamCodeConfig,
      },
    });

    expect(result.defaultModel).toBe('scream-code/scream-for-coding');
    expect(result.defaultThinking).toBe(true);
    expect(config.defaultThinking).toBe(true);
  });

  it('preserves explicit default_thinking when preserving a custom default without capabilities', async () => {
    const config: ManagedScreamConfigShape = {
      providers: {
        custom: {
          type: 'scream',
          apiKey: 'sk-existing',
        },
      },
      defaultModel: 'custom-default',
      defaultThinking: true,
      models: {
        'custom-default': {
          provider: 'custom',
          model: 'custom-model',
          maxContextSize: 1000,
        },
      },
    };

    const result = await provisionManagedScreamCodeConfig({
      accessToken: 'oauth-access-token',
      fetchImpl: vi.fn(async () => makeModelsResponse()) as unknown as typeof fetch,
      preserveDefaultModel: true,
      adapter: {
        read: () => config,
        write: vi.fn(),
        apply: applyManagedScreamCodeConfig,
      },
    });

    expect(result.defaultModel).toBe('custom-default');
    expect(result.defaultThinking).toBe(true);
    expect(config.defaultThinking).toBe(true);
  });

  it('defaults default_thinking to false when a preserved custom default has no signal', async () => {
    const config: ManagedScreamConfigShape = {
      providers: {
        custom: {
          type: 'scream',
          apiKey: 'sk-existing',
        },
      },
      defaultModel: 'custom-default',
      models: {
        'custom-default': {
          provider: 'custom',
          model: 'custom-model',
          maxContextSize: 1000,
        },
      },
    };

    const result = await provisionManagedScreamCodeConfig({
      accessToken: 'oauth-access-token',
      fetchImpl: vi.fn(async () => makeModelsResponse()) as unknown as typeof fetch,
      preserveDefaultModel: true,
      adapter: {
        read: () => config,
        write: vi.fn(),
        apply: applyManagedScreamCodeConfig,
      },
    });

    expect(result.defaultModel).toBe('custom-default');
    expect(result.defaultThinking).toBe(false);
    expect(config.defaultThinking).toBe(false);
  });

  it('does not infer default_thinking from preserved custom default capabilities', async () => {
    const config: ManagedScreamConfigShape = {
      providers: {
        custom: {
          type: 'scream',
          apiKey: 'sk-existing',
        },
      },
      defaultModel: 'custom-default',
      models: {
        'custom-default': {
          provider: 'custom',
          model: 'custom-model',
          maxContextSize: 1000,
          capabilities: [],
        },
      },
    };

    const result = await provisionManagedScreamCodeConfig({
      accessToken: 'oauth-access-token',
      fetchImpl: vi.fn(async () => makeModelsResponse()) as unknown as typeof fetch,
      preserveDefaultModel: true,
      adapter: {
        read: () => config,
        write: vi.fn(),
        apply: applyManagedScreamCodeConfig,
      },
    });

    expect(result.defaultModel).toBe('custom-default');
    expect(result.defaultThinking).toBe(false);
    expect(config.defaultThinking).toBe(false);
  });

  it('keeps default_thinking off even when preserved custom default has thinking capability', async () => {
    const config: ManagedScreamConfigShape = {
      providers: {
        custom: {
          type: 'scream',
          apiKey: 'sk-existing',
        },
      },
      defaultModel: 'custom-default',
      models: {
        'custom-default': {
          provider: 'custom',
          model: 'custom-model',
          maxContextSize: 1000,
          capabilities: ['thinking'],
        },
      },
    };

    const result = await provisionManagedScreamCodeConfig({
      accessToken: 'oauth-access-token',
      fetchImpl: vi.fn(async () => makeModelsResponse()) as unknown as typeof fetch,
      preserveDefaultModel: true,
      adapter: {
        read: () => config,
        write: vi.fn(),
        apply: applyManagedScreamCodeConfig,
      },
    });

    expect(result.defaultModel).toBe('custom-default');
    expect(result.defaultThinking).toBe(false);
    expect(config.defaultThinking).toBe(false);
  });

  it('falls back to the first fetched model when the preserved default was removed', async () => {
    const config: ManagedScreamConfigShape = {
      providers: {
        [SCREAM_CODE_PROVIDER_NAME]: {
          type: 'scream',
          apiKey: '',
        },
      },
      defaultModel: 'scream-code/stale',
      defaultThinking: false,
      models: {
        'scream-code/stale': {
          provider: SCREAM_CODE_PROVIDER_NAME,
          model: 'stale',
          maxContextSize: 1000,
        },
      },
    };

    const result = await provisionManagedScreamCodeConfig({
      accessToken: 'oauth-access-token',
      fetchImpl: vi.fn(async () => makeModelsResponse()) as unknown as typeof fetch,
      preserveDefaultModel: true,
      adapter: {
        read: () => config,
        write: vi.fn(),
        apply: applyManagedScreamCodeConfig,
      },
    });

    expect(result.defaultModel).toBe('scream-code/scream-for-coding');
    expect(result.defaultThinking).toBe(false);
    expect(config.defaultModel).toBe('scream-code/scream-for-coding');
    expect(config.defaultThinking).toBe(false);
  });

  it('removes managed provider, models, services, and default model on logout', () => {
    const config: ManagedScreamConfigShape = {
      providers: {
        [SCREAM_CODE_PROVIDER_NAME]: {
          type: 'scream',
          apiKey: '',
        },
        custom: {
          type: 'scream',
          apiKey: 'sk-existing',
        },
      },
      defaultModel: 'scream-code/scream-for-coding',
      defaultThinking: true,
      models: {
        'scream-code/scream-for-coding': {
          provider: SCREAM_CODE_PROVIDER_NAME,
          model: 'scream-for-coding',
          maxContextSize: 262144,
        },
        'custom-default': {
          provider: 'custom',
          model: 'custom-model',
          maxContextSize: 1000,
        },
      },
      services: {
        screamCliSearch: { baseUrl: 'https://api.scream.com/coding/v1/search' },
        screamCliFetch: { baseUrl: 'https://api.scream.com/coding/v1/fetch' },
        customService: { baseUrl: 'https://service.example.test' },
      },
      raw: {
        default_model: 'scream-code/scream-for-coding',
        providers: {
          [SCREAM_CODE_PROVIDER_NAME]: { type: 'scream' },
          custom: { type: 'scream' },
        },
        models: {
          'scream-code/scream-for-coding': {
            provider: SCREAM_CODE_PROVIDER_NAME,
            model: 'scream-for-coding',
          },
          'custom-default': {
            provider: 'custom',
            model: 'custom-model',
          },
        },
        services: {
          scream_cli_search: { base_url: 'https://api.scream.com/coding/v1/search' },
          scream_cli_fetch: { base_url: 'https://api.scream.com/coding/v1/fetch' },
        },
      },
    };

    applyManagedScreamCodeLogoutConfig(config);

    expect(config.defaultModel).toBeUndefined();
    expect(config.providers[SCREAM_CODE_PROVIDER_NAME]).toBeUndefined();
    expect(config.providers['custom']).toBeDefined();
    expect(config.models?.['scream-code/scream-for-coding']).toBeUndefined();
    expect(config.models?.['custom-default']).toBeDefined();
    expect(config.services?.screamCliSearch).toBeUndefined();
    expect(config.services?.screamCliFetch).toBeUndefined();
    expect(config.services?.['customService']).toEqual({
      baseUrl: 'https://service.example.test',
    });
  });

  it('rejects managed models that do not include a positive context_length', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [{ id: 'scream-for-coding', supports_reasoning: true }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    ) as unknown as typeof fetch;

    await expect(
      fetchManagedScreamCodeModels({
        accessToken: 'oauth-access-token',
        fetchImpl,
      }),
    ).rejects.toThrow(/positive context_length/);
  });

  it('surfaces API error messages from model listing failures', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: 'quota exceeded' } }), {
          status: 429,
          headers: { 'Content-Type': 'application/json' },
        }),
    ) as unknown as typeof fetch;

    await expect(
      fetchManagedScreamCodeModels({
        accessToken: 'oauth-access-token',
        fetchImpl,
      }),
    ).rejects.toThrow('quota exceeded');
  });

  it('clears managed provider, models, default model, and services on logout', () => {
    const config: ManagedScreamConfigShape = {
      providers: {
        [SCREAM_CODE_PROVIDER_NAME]: {
          type: 'scream',
          apiKey: '',
          oauth: { storage: 'file', key: 'oauth/scream-code' },
        },
        custom: {
          type: 'scream',
          apiKey: 'sk-existing',
        },
      },
      defaultModel: 'scream-code/scream-for-coding',
      models: {
        'scream-code/scream-for-coding': {
          provider: SCREAM_CODE_PROVIDER_NAME,
          model: 'scream-for-coding',
          maxContextSize: 262144,
        },
        'custom-default': {
          provider: 'custom',
          model: 'custom-model',
          maxContextSize: 128000,
        },
      },
      services: {
        screamCliSearch: {
          baseUrl: 'https://api.scream.com/coding/v1/search',
          apiKey: '',
          oauth: { storage: 'file', key: 'oauth/scream-code' },
        },
        screamCliFetch: {
          baseUrl: 'https://api.scream.com/coding/v1/fetch',
          apiKey: '',
          oauth: { storage: 'file', key: 'oauth/scream-code' },
        },
        otherService: { baseUrl: 'https://service.example.test' },
      },
    };

    const result = clearManagedScreamCodeConfig(config);

    expect(result).toMatchObject({
      providerName: SCREAM_CODE_PROVIDER_NAME,
      removedProvider: true,
      removedModels: ['scream-code/scream-for-coding'],
      defaultModelCleared: true,
      removedServices: ['screamCliSearch', 'screamCliFetch'],
    });
    expect(config.providers[SCREAM_CODE_PROVIDER_NAME]).toBeUndefined();
    expect(config.providers['custom']).toMatchObject({ apiKey: 'sk-existing' });
    expect(config.defaultModel).toBeUndefined();
    expect(config.models?.['scream-code/scream-for-coding']).toBeUndefined();
    expect(config.models?.['custom-default']).toMatchObject({ provider: 'custom' });
    expect(config.services?.screamCliSearch).toBeUndefined();
    expect(config.services?.screamCliFetch).toBeUndefined();
    expect(config.services?.['otherService']).toMatchObject({
      baseUrl: 'https://service.example.test',
    });
  });
});
