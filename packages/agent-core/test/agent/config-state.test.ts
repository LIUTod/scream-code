import { describe, expect, it } from 'vitest';

import { ProviderManager } from '../../src/session/provider-manager';
import { testAgent } from './harness';

describe('ConfigState model capabilities', () => {
  it('computes provider and model capabilities from ProviderManager metadata', () => {
    const ctx = testAgent({
      providerManager: new ProviderManager({
        config: {
          providers: {
            scream: {
              type: 'scream',
              apiKey: 'test-key',
            },
          },
          models: {
            'scream-code/scream-for-coding': {
              provider: 'scream',
              model: 'scream-for-coding',
              maxContextSize: 1_000_000,
              capabilities: ['image_in', 'video_in', 'thinking', 'tool_use'],
            },
          },
        },
      }),
    });
    const config = ctx.agent.config;

    config.update({ modelAlias: 'scream-code/scream-for-coding' });

    expect(config.model).toBe('scream-code/scream-for-coding');
    expect(config.providerConfig.model).toBe('scream-for-coding');
    expect(config.modelCapabilities).toMatchObject({
      image_in: true,
      video_in: true,
      audio_in: false,
      thinking: true,
      tool_use: true,
      max_context_tokens: 1_000_000,
    });
  });

  it('does not infer Scream capabilities from the provider catalogue', () => {
    const ctx = testAgent({
      providerManager: new ProviderManager({
        config: {
          providers: {
            scream: {
              type: 'scream',
              apiKey: 'test-key',
            },
          },
          models: {
            'scream-code': {
              provider: 'scream',
              model: 'scream-code',
              maxContextSize: 128_000,
            },
          },
        },
      }),
    });
    const config = ctx.agent.config;

    config.update({ modelAlias: 'scream-code' });

    expect(config.modelCapabilities).toMatchObject({
      image_in: false,
      video_in: false,
      audio_in: false,
      max_context_tokens: 128_000,
    });
  });

it('uses session id as a provider prompt cache hint without storing it on Agent', () => {
    const ctx = testAgent({
      providerManager: new ProviderManager({
        promptCacheKey: 'session-test',
        config: {
          providers: {
            scream: {
              type: 'scream',
              apiKey: 'test-key',
            },
          },
          models: {
            'scream-code': {
              provider: 'scream',
              model: 'scream-code',
              maxContextSize: 128_000,
            },
          },
        },
      }),
    });
    const config = ctx.agent.config;

    config.update({ modelAlias: 'scream-code' });

    expect(config.providerConfig).toMatchObject({
      type: 'scream',
      generationKwargs: {
        prompt_cache_key: 'session-test',
      },
    });
    expect('sessionId' in ctx.agent).toBe(false);
  });
});
