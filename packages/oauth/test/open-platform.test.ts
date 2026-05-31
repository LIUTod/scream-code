import { describe, expect, it, vi } from 'vitest';

import {
  applyOpenPlatformConfig,
  capabilitiesForModel,
  fetchOpenPlatformModels,
  filterModelsByPrefix,
  getOpenPlatformById,
  isOpenPlatformId,
  OPEN_PLATFORMS,
  OpenPlatformApiError,
  removeOpenPlatformConfig,
  type ManagedScreamConfigShape,
} from '../src/open-platform';

function makeModelsResponse(): Response {
  return new Response(
    JSON.stringify({
      data: [
        {
          id: 'scream-k2-0712-preview',
          context_length: 256000,
          supports_reasoning: true,
          supports_image_in: true,
          supports_video_in: true,
          display_name: 'Scream K2 0712 Preview',
        },
        {
          id: 'scream-k2-lite',
          context_length: 128000,
          supports_reasoning: false,
          supports_image_in: false,
          supports_video_in: false,
          supports_tool_use: false,
        },
        {
          id: 'non-scream-model',
          context_length: 1000,
          supports_reasoning: false,
        },
      ],
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

describe('OPEN_PLATFORMS', () => {
  it('contains scream-cli.cn and scream-cli.ai', () => {
    expect(getOpenPlatformById('scream-cli-cn')).toMatchObject({
      name: 'ScreamCli AI Open Platform (scream-cli.cn)',
      baseUrl: 'https://api.scream-cli.cn/v1',
      allowedPrefixes: ['scream-k'],
    });
    expect(getOpenPlatformById('scream-cli-ai')).toMatchObject({
      name: 'ScreamCli AI Open Platform (scream-cli.ai)',
      baseUrl: 'https://api.scream-cli.ai/v1',
      allowedPrefixes: ['scream-k'],
    });
    expect(getOpenPlatformById('unknown')).toBeUndefined();
  });

  it('isOpenPlatformId works', () => {
    expect(isOpenPlatformId('scream-cli-cn')).toBe(true);
    expect(isOpenPlatformId('scream-cli-ai')).toBe(true);
    expect(isOpenPlatformId('scream-code')).toBe(false);
  });
});

describe('fetchOpenPlatformModels', () => {
  it('lists and parses models from the platform endpoint', async () => {
    const fetchMock = vi.fn(async () => makeModelsResponse());
    const platform = getOpenPlatformById('scream-cli-cn')!;

    const models = await fetchOpenPlatformModels(platform, 'sk-test', fetchMock as unknown as typeof fetch);

    expect(models).toHaveLength(3);
    expect(models[0]).toMatchObject({
      id: 'scream-k2-0712-preview',
      contextLength: 256000,
      supportsReasoning: true,
      supportsImageIn: true,
      supportsVideoIn: true,
      displayName: 'Scream K2 0712 Preview',
    });
    expect(models[1]?.supportsToolUse).toBe(false);
    expect(models[2]?.id).toBe('non-scream-model');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.scream-cli.cn/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer sk-test',
          Accept: 'application/json',
        }),
      }),
    );
  });

  it('surfaces API error messages and status on HTTP error', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: 'invalid API key' } }), { status: 401 }),
    );
    const platform = getOpenPlatformById('scream-cli-cn')!;

    const error = await fetchOpenPlatformModels(
      platform,
      'sk-bad',
      fetchMock as unknown as typeof fetch,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OpenPlatformApiError);
    expect((error as OpenPlatformApiError).status).toBe(401);
    expect((error as Error).message).toBe('invalid API key');
  });

  it('throws on unexpected response shape', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
    const platform = getOpenPlatformById('scream-cli-cn')!;

    await expect(
      fetchOpenPlatformModels(platform, 'sk-test', fetchMock as unknown as typeof fetch),
    ).rejects.toThrow(/Unexpected models response/);
  });
});

describe('filterModelsByPrefix', () => {
  it('filters by allowedPrefixes when present', () => {
    const platform = getOpenPlatformById('scream-cli-cn')!;
    const models = [
      { id: 'scream-k2-0712-preview', contextLength: 256000, supportsReasoning: true, supportsImageIn: true, supportsVideoIn: true },
      { id: 'gpt-4', contextLength: 1000, supportsReasoning: false, supportsImageIn: false, supportsVideoIn: false },
    ];

    const filtered = filterModelsByPrefix(models as unknown as import('../src/managed-scream-code').ManagedScreamCodeModelInfo[], platform);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.id).toBe('scream-k2-0712-preview');
  });

  it('returns all models when allowedPrefixes is absent', () => {
    const platform: import('../src/open-platform').OpenPlatformDefinition = {
      id: 'custom',
      name: 'Custom',
      baseUrl: 'https://example.com/v1',
    };
    const models = [
      { id: 'model-a', contextLength: 1000, supportsReasoning: false, supportsImageIn: false, supportsVideoIn: false },
      { id: 'model-b', contextLength: 2000, supportsReasoning: false, supportsImageIn: false, supportsVideoIn: false },
    ];

    const filtered = filterModelsByPrefix(models as unknown as import('../src/managed-scream-code').ManagedScreamCodeModelInfo[], platform);
    expect(filtered).toHaveLength(2);
  });
});

describe('capabilitiesForModel', () => {
  it('returns undefined for a model with no capabilities', () => {
    const model = {
      id: 'plain',
      contextLength: 1000,
      supportsReasoning: false,
      supportsImageIn: false,
      supportsVideoIn: false,
      supportsToolUse: false,
    };
    expect(capabilitiesForModel(model)).toBeUndefined();
  });

  it('returns all caps for a full-featured model', () => {
    const model = {
      id: 'full',
      contextLength: 1000,
      supportsReasoning: true,
      supportsImageIn: true,
      supportsVideoIn: true,
      supportsToolUse: true,
    };
    expect(capabilitiesForModel(model)).toEqual(['thinking', 'image_in', 'video_in', 'tool_use']);
  });
});

describe('applyOpenPlatformConfig', () => {
  it('writes provider, models, and defaults', () => {
    const config: ManagedScreamConfigShape = {
      providers: {},
    };
    const platform = getOpenPlatformById('scream-cli-cn')!;
    const models = [
      { id: 'scream-k2-0712-preview', contextLength: 256000, supportsReasoning: true, supportsImageIn: true, supportsVideoIn: true, displayName: 'Scream K2' },
      { id: 'scream-k2-lite', contextLength: 128000, supportsReasoning: false, supportsImageIn: false, supportsVideoIn: false },
    ];

    const result = applyOpenPlatformConfig(config, {
      platform,
      models,
      selectedModel: models[0]!,
      thinking: true,
      apiKey: 'sk-test',
    });

    expect(result).toEqual({
      defaultModel: 'scream-cli-cn/scream-k2-0712-preview',
      defaultThinking: true,
    });

    expect(config.providers['scream-cli-cn']).toMatchObject({
      type: 'scream',
      baseUrl: 'https://api.scream-cli.cn/v1',
      apiKey: 'sk-test',
    });
    expect(config.models?.['scream-cli-cn/scream-k2-0712-preview']).toMatchObject({
      provider: 'scream-cli-cn',
      model: 'scream-k2-0712-preview',
      maxContextSize: 256000,
      capabilities: ['thinking', 'image_in', 'video_in', 'tool_use'],
      displayName: 'Scream K2',
    });
    expect(config.defaultModel).toBe('scream-cli-cn/scream-k2-0712-preview');
    expect(config.defaultThinking).toBe(true);
    expect(config.services).toBeUndefined();
  });

  it('clears stale models for the same provider', () => {
    const config: ManagedScreamConfigShape = {
      providers: {
        'scream-cli-cn': { type: 'scream', baseUrl: 'https://api.scream-cli.cn/v1', apiKey: 'sk-old' },
      },
      models: {
        'scream-cli-cn/stale': { provider: 'scream-cli-cn', model: 'stale', maxContextSize: 1000 },
        'other/model': { provider: 'other', model: 'other-model', maxContextSize: 1000 },
      },
    };
    const platform = getOpenPlatformById('scream-cli-cn')!;
    const models = [
      { id: 'scream-k2-0712-preview', contextLength: 256000, supportsReasoning: true, supportsImageIn: true, supportsVideoIn: true },
    ];

    applyOpenPlatformConfig(config, {
      platform,
      models,
      selectedModel: models[0]!,
      thinking: false,
      apiKey: 'sk-new',
    });

    expect(config.models?.['scream-cli-cn/stale']).toBeUndefined();
    expect(config.models?.['other/model']).toBeDefined();
  });
});

describe('removeOpenPlatformConfig', () => {
  it('removes provider, its models, and defaultModel when matched', () => {
    const config: ManagedScreamConfigShape = {
      providers: {
        'scream-cli-cn': { type: 'scream', baseUrl: 'https://api.scream-cli.cn/v1', apiKey: 'sk-test' },
        'other': { type: 'scream', baseUrl: 'https://other.test/v1', apiKey: 'sk-other' },
      },
      models: {
        'scream-cli-cn/scream-k2': { provider: 'scream-cli-cn', model: 'scream-k2', maxContextSize: 256000 },
        'other/model': { provider: 'other', model: 'other-model', maxContextSize: 1000 },
      },
      defaultModel: 'scream-cli-cn/scream-k2',
    };

    removeOpenPlatformConfig(config, 'scream-cli-cn');

    expect(config.providers['scream-cli-cn']).toBeUndefined();
    expect(config.providers['other']).toBeDefined();
    expect(config.models?.['scream-cli-cn/scream-k2']).toBeUndefined();
    expect(config.models?.['other/model']).toBeDefined();
    expect(config.defaultModel).toBeUndefined();
  });

  it('leaves defaultModel intact when it belongs to another provider', () => {
    const config: ManagedScreamConfigShape = {
      providers: {
        'scream-cli-cn': { type: 'scream', baseUrl: 'https://api.scream-cli.cn/v1', apiKey: 'sk-test' },
      },
      models: {
        'scream-cli-cn/scream-k2': { provider: 'scream-cli-cn', model: 'scream-k2', maxContextSize: 256000 },
      },
      defaultModel: 'other/model',
    };

    removeOpenPlatformConfig(config, 'scream-cli-cn');

    expect(config.defaultModel).toBe('other/model');
  });
});
