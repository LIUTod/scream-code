/**
 * Auxiliary (non-loop) requests — side questions, knowledge-base text calls,
 * goal grading — go through `Agent.generateWithRetry`, the seam that
 * obfuscates secrets, resolves auth, retries and records usage. Before this,
 * none of them recorded usage (`/usage` and the session token cap missed them)
 * and the goal grader bypassed the seam entirely via `rawGenerate`.
 */

import { describe, expect, it, vi } from 'vitest';

import { Agent } from '../../src/agent';
import { createGoalGrader } from '../../src/agent/tool';
import { testAgent } from './harness/agent';

// A default secret pattern (GitHub PAT) — active with no `secrets` config.
const TOKEN = `ghp_${'A1b2C3d4E5'.repeat(3)}abcdef`;

function configured() {
  const ctx = testAgent();
  ctx.configure({ tools: [] });
  const alias = ctx.agent.config.modelAlias;
  if (alias === undefined) throw new Error('test agent has no model alias');
  return { ctx, alias };
}

describe('auxiliary request usage', () => {
  it('records a side question under the session alias, outside any turn total', async () => {
    const { ctx, alias } = configured();
    ctx.mockNextResponse({ type: 'text', text: 'side answer' });

    await expect(ctx.agent.sideQuestion('what was that?')).resolves.toBe('side answer');

    const usage = ctx.agent.usage.data();
    expect(usage.byModel?.[alias]?.inputOther ?? 0).toBeGreaterThan(0);
    // Session scope: a side question never counts toward the turn HitR.
    expect(usage.turnTotal).toBeUndefined();
    expect(usage.currentTurn).toBeUndefined();
  });

  it('records generateText (knowledge-base extraction / rerank) usage', async () => {
    const { ctx, alias } = configured();
    ctx.mockNextResponse({ type: 'text', text: 'extracted' });

    await ctx.agent.generateText('extract entities', 'some document text');

    expect(ctx.agent.usage.data().byModel?.[alias]?.output ?? 0).toBeGreaterThan(0);
  });
});

describe('goal grader', () => {
  it('obfuscates the graded output and records usage', async () => {
    const { ctx, alias } = configured();
    ctx.mockNextResponse({
      type: 'text',
      text: '{"pass": true, "reason": "criterion met", "issues": []}',
    });

    const grader = createGoalGrader(ctx.agent);
    await grader('ship the fix', 'tests pass', `done; deployed with token ${TOKEN}`);

    expect(ctx.llmCalls).toHaveLength(1);
    expect(JSON.stringify(ctx.llmCalls[0])).not.toContain(TOKEN);
    expect(ctx.agent.usage.data().byModel?.[alias]).toBeDefined();
  });
});

describe('Agent.generate', () => {
  it('surfaces a failure before the first await as a rejection, not a synchronous throw', async () => {
    // Obfuscation runs before the first await. `generate` used to be an async
    // function; callers (the retry wrapper, `.catch()` chains) rely on that.
    const { ctx } = configured();
    const spy = vi
      .spyOn(Agent.prototype as unknown as { obfuscator: unknown }, 'obfuscator', 'get')
      .mockImplementation(() => {
        throw new Error('obfuscator exploded');
      });
    try {
      let returned: Promise<unknown> | undefined;
      expect(() => {
        returned = ctx.agent.generate(ctx.agent.config.provider, 'system', [], []);
      }).not.toThrow();
      await expect(returned).rejects.toThrow('obfuscator exploded');
    } finally {
      spy.mockRestore();
    }
  });
});
