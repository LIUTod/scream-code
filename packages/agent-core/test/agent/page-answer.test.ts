import { describe, expect, it } from 'vitest';

import type { ScreamConfig } from '../../src/config';
import type { TestAgentOptions } from './harness/agent';
import { testAgent } from './harness/agent';

const BASE: ScreamConfig = {
  providers: {
    'main-provider': { type: 'scream', apiKey: 'main-key' },
    'cheap-provider': { type: 'scream', apiKey: 'cheap-key' },
  },
  models: {
    main: { provider: 'main-provider', model: 'main-model', maxContextSize: 128_000 },
    cheap: { provider: 'cheap-provider', model: 'cheap-model', maxContextSize: 64_000 },
  },
};

function capture(): {
  generate: NonNullable<TestAgentOptions['generate']>;
  calls: Array<{ model: string; system: string; text: string }>;
} {
  const calls: Array<{ model: string; system: string; text: string }> = [];
  return {
    calls,
    generate: async (provider, systemPrompt, _tools, history) => {
      const first = history[0]?.content;
      const text = Array.isArray(first) ? first.map((part) => (part.type === 'text' ? part.text : '')).join('') : '';
      calls.push({ model: (provider as { modelName: string }).modelName, system: String(systemPrompt), text });
      return {
        id: 'answer',
        message: { role: 'assistant', content: [{ type: 'text', text: '  Version 4.2.  ' }], toolCalls: [] },
        usage: { inputOther: 100, output: 5, inputCacheRead: 0, inputCacheCreation: 0 },
        finishReason: 'completed',
        rawFinishReason: 'stop',
      };
    },
  };
}

describe('Agent.answerFromPage', () => {
  it('asks the housekeeping model and bills it', async () => {
    const { generate, calls } = capture();
    const ctx = testAgent({ generate, initialConfig: { ...BASE, loopControl: { housekeepingModel: 'cheap' } } });
    ctx.agent.config.update({ modelAlias: 'main', thinkingLevel: 'off' });

    const answer = await ctx.agent.answerFromPage({ url: 'https://example.com', question: 'Which version?', content: 'page body' });

    expect(answer).toBe('Version 4.2.');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.model).toBe('cheap-model');
    expect(calls[0]!.system).toContain('one web page');
    expect(calls[0]!.text).toContain('Question: Which version?');
    expect(calls[0]!.text).toContain('page body');
    const byModel = ctx.agent.usage.data().byModel ?? {};
    expect(byModel['cheap']).toBeDefined();
    expect(byModel['main']).toBeUndefined();
  });

  it('uses the session model when no housekeeping model is set, and caps a huge page', async () => {
    const { generate, calls } = capture();
    const ctx = testAgent({ generate, initialConfig: BASE });
    ctx.agent.config.update({ modelAlias: 'main', thinkingLevel: 'off' });

    await ctx.agent.answerFromPage({ url: 'https://example.com', question: 'q', content: 'z'.repeat(200_000) });

    expect(calls[0]!.model).toBe('main-model');
    expect(calls[0]!.text).toContain('[page cut at 120000 characters]');
    expect(calls[0]!.text.length).toBeLessThan(130_000);
    expect(ctx.agent.usage.data().byModel?.['main']).toBeDefined();
  });
});
