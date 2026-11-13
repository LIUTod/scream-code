import { createProvider, type KeyRing, type ProviderConfig as LtodProviderConfig } from '@scream-code/ltod';
import { describe, expect, it } from 'vitest';

import type { ScreamConfig } from '../../src/config';
import { ProviderManager, SingleModelProvider } from '../../src/session/provider-manager';

function ringOf(provider: LtodProviderConfig): KeyRing | undefined {
  return 'keyRing' in provider ? provider.keyRing : undefined;
}

function configWithKeys(apiKey: string[]): ScreamConfig {
  return {
    defaultModel: 'claude/sonnet',
    providers: {
      'anthropic-main': { type: 'anthropic', apiKey },
    },
    models: {
      'claude/sonnet': {
        provider: 'anthropic-main',
        model: 'claude-sonnet-4-5',
        maxContextSize: 200_000,
      },
    },
  };
}

const CONFIG: ScreamConfig = {
  defaultModel: 'claude/sonnet',
  providers: {
    'anthropic-main': { type: 'anthropic', apiKey: ['key-1', 'key-2'] },
    'openai-main': { type: 'openai_responses', apiKey: ['oa-1', 'oa-2'] },
    'scream-main': { type: 'scream', apiKey: 'single-key' },
  },
  models: {
    'claude/sonnet': {
      provider: 'anthropic-main',
      model: 'claude-sonnet-4-5',
      maxContextSize: 200_000,
    },
    'gpt/main': { provider: 'openai-main', model: 'gpt-4.1', maxContextSize: 128_000 },
    'scream/default': {
      provider: 'scream-main',
      model: 'scream-for-coding',
      maxContextSize: 1_000_000,
    },
  },
};

describe('ProviderManager: session key rings', () => {
  it('reuses one ring per provider config entry across provider creations', () => {
    const manager = new ProviderManager({ config: CONFIG, promptCacheKey: 'session-a' });

    const first = manager.resolveProviderConfig('claude/sonnet');
    const second = manager.resolveProviderConfig('claude/sonnet');

    const ring = ringOf(first.provider);
    expect(ring).toBeDefined();
    expect(ring?.size()).toBe(2);
    // The resolved config is rebuilt per call; the ring is not.
    expect(first.provider).not.toBe(second.provider);
    expect(ringOf(second.provider)).toBe(ring);

    // Both providers built for that entry carry the same ring instance.
    const providerA = createProvider(first.provider);
    const providerB = createProvider(second.provider);
    expect(Reflect.get(providerA, '_keyRing')).toBe(ring);
    expect(Reflect.get(providerB, '_keyRing')).toBe(ring);

    // A rotation through one instance advances the shared pool.
    const before = ring?.current();
    expect(providerA.rotateApiKey?.()).toBe(true);
    expect(ring?.current()).not.toBe(before);
  });

  it('gives each configured provider its own ring', () => {
    const manager = new ProviderManager({ config: CONFIG, promptCacheKey: 'session-a' });

    const anthropicRing = ringOf(manager.resolveProviderConfig('claude/sonnet').provider);
    const openaiRing = ringOf(manager.resolveProviderConfig('gpt/main').provider);

    expect(anthropicRing).toBeDefined();
    expect(openaiRing).toBeDefined();
    expect(openaiRing).not.toBe(anthropicRing);
    // The affinity seed picks the start key, so only pool membership is fixed.
    expect(['oa-1', 'oa-2']).toContain(openaiRing?.current());
  });

  it('leaves single-key providers without a ring', () => {
    const manager = new ProviderManager({ config: CONFIG, promptCacheKey: 'session-a' });
    const scream = manager.resolveProviderConfig('scream/default');
    expect('keyRing' in scream.provider).toBe(false);
    expect(createProvider(scream.provider).rotateApiKey).toBeUndefined();
  });

  it('spreads sessions across the pool by affinity seed', () => {
    const keys = ['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7', 'k8'];
    const starts = new Set<string>();
    for (let index = 0; index < 24; index += 1) {
      const manager = new ProviderManager({
        config: configWithKeys(keys),
        promptCacheKey: `session-${index}`,
      });
      const ring = ringOf(manager.resolveProviderConfig('claude/sonnet').provider);
      starts.add(ring!.current()!);
    }
    expect(starts.size).toBeGreaterThan(1);
  });
});

describe('SingleModelProvider: key ring', () => {
  it('keeps one ring for every resolution of its single model', () => {
    const manager = new SingleModelProvider({
      type: 'anthropic',
      model: 'claude-sonnet-4-5',
      apiKey: ['key-1', 'key-2'],
    });

    const first = ringOf(manager.resolveProviderConfig('claude-sonnet-4-5').provider);
    const second = ringOf(manager.resolveProviderConfig('claude-sonnet-4-5').provider);

    expect(first).toBeDefined();
    expect(first?.size()).toBe(2);
    expect(second).toBe(first);
  });
});
