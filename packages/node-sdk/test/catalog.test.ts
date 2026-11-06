import type { ScreamConfig } from '@scream-code/agent-core';
import { describe, expect, it, vi } from 'vitest';

import {
  applyCatalogProvider,
  catalogModelToAlias,
  catalogProviderModels,
  CatalogFetchError,
  fetchCatalog,
  fetchCatalogWithMeta,
  loadCatalogCache,
  loadCatalogCacheMeta,
  saveCatalogCache,
  resolveCatalogSessionHeader,
  type CatalogModel,
} from '../src/catalog';

function catalogResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const model: CatalogModel = {
  id: 'm1',
  name: 'M1',
  maxOutputSize: 64000,
  capability: {
    image_in: true,
    video_in: false,
    audio_in: false,
    thinking: true,
    tool_use: true,
    max_context_tokens: 200000,
  },
};

describe('fetchCatalog', () => {
  it('fetches and returns the catalog map', async () => {
    const catalog = { anthropic: { id: 'anthropic', models: { x: { id: 'x', limit: { context: 1000 } } } } };
    const fetchMock = vi.fn(async () => catalogResponse(catalog));
    const result = await fetchCatalog('https://x/api.json', undefined, fetchMock as unknown as typeof fetch);
    expect(result).toEqual(catalog);
  });

  it('throws CatalogFetchError on HTTP error', async () => {
    const fetchMock = vi.fn(async () => catalogResponse('no', 500));
    await expect(
      fetchCatalog('https://x', undefined, fetchMock as unknown as typeof fetch),
    ).rejects.toBeInstanceOf(CatalogFetchError);
  });

  it('throws on a non-object payload', async () => {
    const fetchMock = vi.fn(async () => catalogResponse([1, 2]));
    await expect(
      fetchCatalog('https://x', undefined, fetchMock as unknown as typeof fetch),
    ).rejects.toThrow(/Unexpected catalog response/);
  });
});

describe('catalogModelToAlias', () => {
  it('flattens a catalog model capability into alias fields', () => {
    expect(catalogModelToAlias('anthropic', model)).toEqual({
      provider: 'anthropic',
      model: 'm1',
      maxContextSize: 200000,
      maxOutputSize: 64000,
      capabilities: ['image_in', 'thinking', 'tool_use'],
      displayName: 'M1',
    });
  });
});

describe('applyCatalogProvider', () => {
  it('writes provider, model aliases, and defaults', () => {
    const config = { providers: {} } as ScreamConfig;
    const result = applyCatalogProvider(config, {
      providerId: 'anthropic',
      wire: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'sk',
      models: [model],
      selectedModelId: 'm1',
      thinking: true,
    });

    expect(result.defaultModel).toBe('anthropic/m1');
    expect(config.providers['anthropic']).toMatchObject({ type: 'anthropic', apiKey: 'sk' });
    expect(config.models?.['anthropic/m1']).toMatchObject({
      provider: 'anthropic',
      model: 'm1',
      maxContextSize: 200000,
    });
    expect(config.defaultModel).toBe('anthropic/m1');
    expect(config.defaultThinking).toBe(true);
  });

  it('writes interleaved reasoning key from a catalog-selected model alias', () => {
    const models = catalogProviderModels({
      id: 'deepseek',
      models: {
        'deepseek-v4-pro': {
          id: 'deepseek-v4-pro',
          name: 'DeepSeek V4 Pro',
          family: 'deepseek-thinking',
          limit: { context: 1000000, output: 384000 },
          reasoning: true,
          tool_call: true,
          interleaved: { field: 'reasoning_content' },
        },
      },
    });
    const config = { providers: {} } as ScreamConfig;

    applyCatalogProvider(config, {
      providerId: 'deepseek',
      wire: 'openai',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk',
      models,
      selectedModelId: 'deepseek-v4-pro',
      thinking: true,
    });

    expect(config.models?.['deepseek/deepseek-v4-pro']).toMatchObject({
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      reasoningKey: 'reasoning_content',
    });
  });

  it('clears stale aliases for the same provider but keeps others', () => {
    const config = {
      providers: { anthropic: { type: 'anthropic', apiKey: 'old' } },
      models: {
        'anthropic/stale': { provider: 'anthropic', model: 'stale', maxContextSize: 1 },
        'other/keep': { provider: 'other', model: 'keep', maxContextSize: 1 },
      },
    } as unknown as ScreamConfig;

    applyCatalogProvider(config, {
      providerId: 'anthropic',
      wire: 'anthropic',
      apiKey: 'new',
      models: [model],
      selectedModelId: 'm1',
      thinking: false,
    });

    expect(config.models?.['anthropic/stale']).toBeUndefined();
    expect(config.models?.['other/keep']).toBeDefined();
  });
});


describe('sessionHeader stamp', () => {
  it('stamps the session header for a known catalog provider id', () => {
    const config = { providers: {} } as ScreamConfig;
    applyCatalogProvider(config, {
      providerId: 'opencode-go',
      wire: 'openai',
      // No base URL: the id alone must be enough to stamp.
      apiKey: 'sk',
      models: [model],
      selectedModelId: 'm1',
    });

    expect(config.providers['opencode-go']).toMatchObject({
      type: 'openai',
      sessionHeader: 'x-opencode-session',
    });
  });

  it('stamps by exact base URL for a DIY provider id', () => {
    const config = { providers: {} } as ScreamConfig;
    applyCatalogProvider(config, {
      providerId: 'custom-gateway',
      wire: 'openai',
      baseUrl: 'https://opencode.ai/zen/v1',
      apiKey: 'sk',
      models: [model],
      selectedModelId: 'm1',
    });

    expect(config.providers['custom-gateway']).toMatchObject({
      sessionHeader: 'x-opencode-session',
    });

    const trailing = { providers: {} } as ScreamConfig;
    applyCatalogProvider(trailing, {
      providerId: 'custom-gateway',
      wire: 'openai',
      baseUrl: 'https://opencode.ai/zen/v1/',
      apiKey: 'sk',
      models: [model],
      selectedModelId: 'm1',
    });

    expect(trailing.providers['custom-gateway']).toMatchObject({
      sessionHeader: 'x-opencode-session',
    });
  });

  it('does not stamp unknown ids or unrelated base URLs', () => {
    const config = { providers: {} } as ScreamConfig;
    applyCatalogProvider(config, {
      providerId: 'other-gateway',
      wire: 'anthropic',
      baseUrl: 'https://example.com',
      apiKey: 'sk',
      models: [model],
      selectedModelId: 'm1',
    });

    expect('sessionHeader' in (config.providers['other-gateway'] ?? {})).toBe(false);
    expect(resolveCatalogSessionHeader('other-gateway', 'https://example.com')).toBeUndefined();
    expect(resolveCatalogSessionHeader('custom-x', 'https://example.com/v1')).toBeUndefined();
  });

  it('prefers an explicit sessionHeader option over the stamp', () => {
    const config = { providers: {} } as ScreamConfig;
    applyCatalogProvider(config, {
      providerId: 'opencode',
      wire: 'openai',
      baseUrl: 'https://opencode.ai/zen/v1',
      apiKey: 'sk',
      models: [model],
      selectedModelId: 'm1',
      sessionHeader: 'x-custom-session',
    });

    expect(config.providers['opencode']).toMatchObject({
      sessionHeader: 'x-custom-session',
    });
  });
});

describe('catalog cache freshness', () => {
  it('reads a legacy bare-catalog cache and writes meta alongside it', async () => {
    const { mkdtemp, writeFile, readFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const home = await mkdtemp(join(tmpdir(), 'scream-catalog-'));

    const legacy = { anthropic: { id: 'anthropic', models: {} } };
    await writeFile(join(home, 'catalog-cache.json'), JSON.stringify(legacy), 'utf-8');

    expect(loadCatalogCache(home)).toEqual(legacy);
    expect(loadCatalogCacheMeta(home)).toEqual({});

    saveCatalogCache(legacy, home, { fetchedAt: '2026-01-01T00:00:00.000Z', etag: 'W/"1"' });
    expect(loadCatalogCache(home)).toEqual(legacy);
    expect(loadCatalogCacheMeta(home)).toEqual({
      fetchedAt: '2026-01-01T00:00:00.000Z',
      etag: 'W/"1"',
    });
    const raw = JSON.parse(await readFile(join(home, 'catalog-cache.json'), 'utf-8'));
    expect(raw.catalog).toEqual(legacy);
  });

  it('sends If-None-Match and reports 304 as not modified', async () => {
    const calls: Array<{ headers?: Record<string, string> }> = [];
    const fetchMock = vi.fn(async (_url: string, init?: { headers?: Record<string, string> }) => {
      calls.push({ ...(init?.headers === undefined ? {} : { headers: init.headers }) });
      return new Response(null, { status: 304 });
    });

    const result = await fetchCatalogWithMeta(
      'https://x/api.json',
      { etag: 'W/"abc"' },
      fetchMock as unknown as typeof fetch,
    );

    expect(result.notModified).toBe(true);
    expect(calls[0]?.headers?.['If-None-Match']).toBe('W/"abc"');
  });

  it('returns the new catalog and its ETag on 200', async () => {
    const catalog = { anthropic: { id: 'anthropic', models: {} } };
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(catalog), {
          status: 200,
          headers: { 'Content-Type': 'application/json', etag: 'W/"new"' },
        }),
    );

    const result = await fetchCatalogWithMeta(
      'https://x/api.json',
      {},
      fetchMock as unknown as typeof fetch,
    );

    expect(result.notModified).toBe(false);
    expect(result.catalog).toEqual(catalog);
    expect(result.etag).toBe('W/"new"');
  });
});
