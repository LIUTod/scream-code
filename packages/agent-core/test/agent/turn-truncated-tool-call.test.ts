/**
 * A model that hits its output-token limit while writing a tool call leaves the
 * call's arguments cut off. The loop records it as not executed (so the
 * transcript stays paired) — but the turn then ended, the model never saw that
 * result, and the user had to type "continue". What the model needs to hear is
 * that its OUTPUT was too long, not that "the provider stream was interrupted",
 * or it re-sends the same oversized payload. The turn continues, a bounded
 * number of times, so the model can retry with smaller calls.
 */
import type { ToolCall } from '@scream-code/ltod';
import { describe, expect, it } from 'vitest';

import { DEFAULT_AGENT_PROFILES } from '../../src/profile';
import { TURN_DEFAULTS } from '../../src/agent/turn/defaults';
import { testAgent } from './harness/agent';

const TEST_PROVIDER = { type: 'scream', apiKey: 'test-key', model: 'scream-code' } as const;
const TEST_MODEL_CAPABILITIES = {
  image_in: true,
  video_in: true,
  audio_in: false,
  thinking: true,
  tool_use: true,
  max_context_tokens: 256_000,
} as const;

function mainAgent() {
  const ctx = testAgent();
  ctx.configure({
    provider: TEST_PROVIDER,
    modelCapabilities: TEST_MODEL_CAPABILITIES,
    tools: ['Write'],
  });
  ctx.agent.useProfile(DEFAULT_AGENT_PROFILES['agent']!);
  return ctx;
}

function cutOffWrite(id: string): ToolCall {
  // The arguments end mid-string, as a stream cut by the output limit leaves them.
  return {
    type: 'function',
    id,
    name: 'Write',
    arguments: '{"path":"/tmp/big.txt","content":"first part of a very long fi',
  };
}

function truncatedResponse(ctx: ReturnType<typeof mainAgent>, id: string): void {
  ctx.mockNextProviderResponse({
    parts: [{ type: 'text', text: 'Writing the file.' }, cutOffWrite(id)],
    finishReason: 'truncated',
    rawFinishReason: 'length',
  });
}

async function runTurn(ctx: ReturnType<typeof mainAgent>, text: string): Promise<void> {
  await ctx.rpc.prompt({ input: [{ type: 'text', text }] });
  await ctx.untilTurnEnd();
}

describe('a tool call cut off by the output limit', () => {
  it('continues the turn so the model can retry, and tells it the output was too long', async () => {
    const ctx = mainAgent();
    truncatedResponse(ctx, 'call_1');
    ctx.mockNextResponse({ type: 'text', text: 'Splitting it into smaller writes.' });

    await runTurn(ctx, 'write a big file');

    expect(ctx.llmCalls).toHaveLength(2);
    const retryHistory = JSON.stringify(ctx.llmCalls[1]?.history);
    expect(retryHistory).toContain('output-token limit');
    expect(retryHistory).toContain('smaller');
    expect(retryHistory).not.toContain('provider stream was interrupted');
  });

  it('is bounded: a model that keeps overrunning is stopped after the retry cap', async () => {
    const ctx = mainAgent();
    const cap = TURN_DEFAULTS.maxTruncatedToolRetries;
    for (let attempt = 0; attempt <= cap + 1; attempt += 1) {
      truncatedResponse(ctx, `call_${String(attempt)}`);
    }

    await runTurn(ctx, 'write a huge file');

    // The first request plus `cap` retries, then the turn ends.
    expect(ctx.llmCalls).toHaveLength(1 + cap);
  });

  it('gives each turn its own retry budget', async () => {
    const ctx = mainAgent();
    const cap = TURN_DEFAULTS.maxTruncatedToolRetries;
    // Each turn spends its WHOLE budget (cap truncations) and then succeeds.
    const scriptTurn = (name: string): void => {
      for (let attempt = 0; attempt < cap; attempt += 1) {
        truncatedResponse(ctx, `call_${name}${String(attempt)}`);
      }
      ctx.mockNextResponse({ type: 'text', text: `done ${name}` });
    };

    scriptTurn('a');
    await runTurn(ctx, 'first big file');
    expect(ctx.llmCalls).toHaveLength(1 + cap);

    scriptTurn('b');
    await runTurn(ctx, 'second big file');

    // A budget carried over from the first turn would end this one on its first
    // truncated reply.
    expect(ctx.llmCalls).toHaveLength(2 * (1 + cap));
  });

  it('does not continue for a subagent, whose truncation is reported to its parent', async () => {
    const ctx = testAgent();
    ctx.configure({
      provider: TEST_PROVIDER,
      modelCapabilities: TEST_MODEL_CAPABILITIES,
      tools: ['Write'],
    });
    ctx.agent.useProfile(DEFAULT_AGENT_PROFILES['explore']!);
    truncatedResponse(ctx, 'call_sub');
    ctx.mockNextResponse({ type: 'text', text: 'should not be requested' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'sub task' }] });
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(1);
  });
});

describe('a TEXT reply cut off by the output limit', () => {
  /** Compactable history: compaction needs messages to fold. */
  function mainAgentWithHistory() {
    const ctx = mainAgent();
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.appendExchange(2, 'old user two', 'old assistant two', 40);
    ctx.appendExchange(3, 'recent user three', 'recent assistant three', 120);
    return ctx;
  }

  function truncatedText(ctx: ReturnType<typeof mainAgent>): void {
    ctx.mockNextProviderResponse({
      parts: [{ type: 'text', text: 'A very long answer that gets cut' }],
      finishReason: 'truncated',
      rawFinishReason: 'length',
    });
  }

  it('is recovered once per turn — not once per session', async () => {
    const ctx = mainAgentWithHistory();
    for (let turn = 1; turn <= 2; turn += 1) {
      truncatedText(ctx);
      ctx.mockNextResponse({ type: 'text', text: `Compacted summary ${String(turn)}.` });
      ctx.mockNextResponse({ type: 'text', text: `Finished turn ${String(turn)}.` });
    }

    await runTurn(ctx, 'first long answer');
    const afterFirst = ctx.llmCalls.length;
    expect(afterFirst).toBe(3); // truncated reply, compaction summary, continuation

    await runTurn(ctx, 'second long answer');

    // The second turn gets the same recovery: with a session-wide flag it would
    // have ended on its truncated reply (one call instead of three).
    expect(ctx.llmCalls.length - afterFirst).toBe(3);
  });
});
