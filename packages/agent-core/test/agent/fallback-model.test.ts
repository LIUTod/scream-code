import { APIStatusError } from '@scream-code/ltod';
import { describe, expect, it } from 'vitest';

import type { AgentOptions } from '../../src/agent';
import type { ScreamConfig } from '../../src/config';
import type { TestAgentOptions } from './harness/agent';
import { testAgent } from './harness/agent';

const CONFIG: ScreamConfig = {
  providers: {
    'main-provider': { type: 'scream', apiKey: 'main-key' },
    'backup-provider': { type: 'scream', apiKey: 'backup-key' },
  },
  models: {
    main: { provider: 'main-provider', model: 'main-model', maxContextSize: 128_000, capabilities: ['tool_use'] },
    backup: { provider: 'backup-provider', model: 'backup-model', maxContextSize: 64_000 },
  },
};

/** Stand-in for the session's live model-tier bindings (set in `/model`). */
function tierHost(fallback: string | undefined): AgentOptions['subagentHost'] {
  return {
    resolveModelTier: (tier: string) => (tier === 'fallback' ? fallback : undefined),
  } as unknown as AgentOptions['subagentHost'];
}

describe('Agent.resolveFallbackLlm', () => {
  it('builds the fallback model from the live binding, on its own provider', () => {
    const ctx = testAgent({ initialConfig: CONFIG, subagentHost: tierHost('backup') });
    ctx.agent.config.update({ modelAlias: 'main', thinkingLevel: 'off' });
    const llm = ctx.agent.resolveFallbackLlm();
    expect(llm?.modelName).toBe('backup');
  });

  it('gives none when unset, when it is the model in use, or when the alias no longer resolves', () => {
    for (const fallback of [undefined, 'main', 'deleted-alias']) {
      const ctx = testAgent({ initialConfig: CONFIG, subagentHost: tierHost(fallback) });
      ctx.agent.config.update({ modelAlias: 'main', thinkingLevel: 'off' });
      expect(ctx.agent.resolveFallbackLlm(), String(fallback)).toBeUndefined();
    }
  });
});

describe('a turn on the fallback model', () => {
  it('answers from the fallback model when the session model rejects its key, and bills it', async () => {
    const providers: string[] = [];
    const generate: NonNullable<TestAgentOptions['generate']> = async (provider) => {
      const model = (provider as { modelName: string }).modelName;
      providers.push(model);
      if (model === 'main-model') throw new APIStatusError(401, 'Invalid API key');
      return {
        id: 'fallback-reply',
        message: { role: 'assistant', content: [{ type: 'text', text: 'answered by backup' }], toolCalls: [] },
        usage: { inputOther: 10, output: 5, inputCacheRead: 0, inputCacheCreation: 0 },
        finishReason: 'completed',
        rawFinishReason: 'stop',
      };
    };
    const ctx = testAgent({ generate, initialConfig: CONFIG, subagentHost: tierHost('backup') });
    ctx.agent.config.update({ modelAlias: 'main', thinkingLevel: 'off' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello' }] });
    await ctx.untilTurnEnd();

    // The session model was asked once; every later request of the turn (the
    // turn may take more than one step) went straight to the fallback model.
    expect(providers[0]).toBe('main-model');
    expect(providers.slice(1).length).toBeGreaterThan(0);
    expect(providers.slice(1).every((model) => model === 'backup-model')).toBe(true);
    const byModel = ctx.agent.usage.data().byModel ?? {};
    expect(byModel['backup']).toBeDefined();
    expect(byModel['main']).toBeUndefined();
  });
});
