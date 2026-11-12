/**
 * `loop_control.compaction_mode = "off"`: for unattended / IM sessions that
 * must not stall on a compaction LLM call. No micro, no auto compaction; at
 * the blocking threshold the model gets a one-time wrap-up warning per
 * episode, and the provider's own context limit remains the hard backstop.
 * Manual /compact still works (it bypasses checkAutoCompaction).
 */
import { describe, expect, it } from 'vitest';

import type { ModelCapability } from '@scream-code/ltod';
import type { ContextMessage } from '#/agent/context/types';
import { MicroCompaction } from '#/agent/compaction/micro';
import { testAgent } from './harness/agent';

const MODEL_CAPABILITIES: ModelCapability = {
  image_in: true,
  video_in: true,
  audio_in: false,
  thinking: true,
  tool_use: true,
  max_context_tokens: 256_000,
} as never;

const TEST_PROVIDER = { type: 'scream', apiKey: 'test-key', model: 'scream-code' } as const;

// Five exchanges reaching a 300k gauge: above the 90% block threshold of the
// 256k window, and with a compactable prefix (a single giant unsplittable
// message would make the auto path degrade gracefully with no split).
// Provider usage is cumulative, so the gauge is the LAST step's total.
const EXCHANGES = 5;
const WARNING_FRAGMENT = 'auto-compaction is disabled';

function makeAgent(initialConfig?: unknown): ReturnType<typeof testAgent> {
  const ctx = testAgent(
    initialConfig === undefined ? {} : ({ initialConfig } as { initialConfig: never }),
  );
  ctx.configure({ provider: TEST_PROVIDER, modelCapabilities: MODEL_CAPABILITIES });
  for (let index = 1; index <= EXCHANGES; index += 1) {
    ctx.appendExchange(
      index,
      `user message ${String(index)}`,
      `assistant reply ${String(index)}`,
      index * 60_000,
    );
  }
  return ctx;
}

function offWarningCount(ctx: ReturnType<typeof testAgent>): number {
  return ctx.agent.context.history.filter((message) => {
    const content = message.content;
    const text =
      typeof content === 'string'
        ? content
        : content.map((part) => (part.type === 'text' ? part.text : '')).join('');
    return text.includes(WARNING_FRAGMENT);
  }).length;
}

describe('compaction mode off', () => {
  it('warns once at the blocking threshold and never compacts', async () => {
    const ctx = makeAgent({ loopControl: { compactionMode: 'off' } });

    await ctx.agent.fullCompaction.beforeStep(new AbortController().signal);
    expect(offWarningCount(ctx)).toBe(1);

    // A second step at the same threshold stays silent: one wrap-up warning
    // per episode, not one per step.
    await ctx.agent.fullCompaction.beforeStep(new AbortController().signal);
    expect(offWarningCount(ctx)).toBe(1);

    // No compaction machinery ran: no compaction LLM call, nothing applied.
    expect(ctx.llmCalls.length).toBe(0);
    expect(ctx.agent.fullCompaction.compactedHistory.length).toBe(0);
  });

  it('still runs auto compaction in the default mode at the same threshold', async () => {
    const ctx = makeAgent();
    ctx.mockNextResponse({ type: 'text', text: 'Compacted summary.' });
    const compacted = new Promise<void>((resolve) => {
      ctx.emitter.once('full_compaction.complete', () => {
        resolve();
      });
    });

    await ctx.agent.fullCompaction.beforeStep(new AbortController().signal);
    await Promise.race([compacted, new Promise((resolve) => setTimeout(resolve, 3_000))]);

    expect(ctx.llmCalls.length).toBeGreaterThan(0);
    expect(ctx.agent.fullCompaction.compactedHistory.length).toBeGreaterThan(0);
  }, 15_000);

  /**
   * The micro gate is the load-bearing half of off mode: the context read
   * paths call `detect()` on every request, so without the gate the cutoff
   * would advance behind the caller's back and `estimateSavings` would double
   * the savings the off-mode gauge already assumes. Pinned at the unit level
   * with the same hand-built history the micro tests use — the harness's
   * record chain makes droppable tool results impractical to assemble here.
   */
  it('setEnabled(false) makes compact and estimateSavings no-ops', () => {
    const makeMicro = () =>
      new MicroCompaction({} as never, {
        keepRecentMessages: 0,
        minContentTokens: 100,
        minContextUsageRatio: 0,
        truncatedMarker: '[cleared]',
        uselessMarker: '[uneventful]',
      });
    const history: ContextMessage[] = [
      {
        role: 'tool',
        toolCallId: '1',
        toolCalls: [],
        content: [{ type: 'text', text: 'x'.repeat(500) }],
        useless: true,
      } as ContextMessage,
    ];

    const enabled = makeMicro();
    // @ts-expect-error: cutoff is private; the micro tests set it directly.
    enabled.cutoff = 1;
    expect(enabled.compact(history)[0]!.content[0]).toMatchObject({
      type: 'text',
      text: '[uneventful]',
    });
    expect(enabled.estimateSavings(history)).toBeGreaterThan(0);

    const disabled = makeMicro();
    disabled.setEnabled(false);
    // @ts-expect-error: cutoff is private; the micro tests set it directly.
    disabled.cutoff = 1;
    expect(disabled.compact(history)).toEqual(history);
    expect(disabled.estimateSavings(history)).toBe(0);
  });
});
