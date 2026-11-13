/**
 * One session, one measurement scale.
 *
 * Every local estimate that adjusts the context gauge (undo, edit_message,
 * open-step cleanup, the cached-prefix debug log) and every compaction
 * cut-point decision (strategy + micro) must read the alias's configured
 * tokenizer. Mixing the character heuristic with an exact encoding inside one
 * session drifts the watermark against itself: the gauge and the compaction
 * trigger would disagree about how full the context is.
 *
 * The fixtures use a 400-character unbroken run: the heuristic counts it as
 * 100 tokens, cl100k as 50 (the long-run sampler keeps the exact-encode path
 * bounded), so a call site that ignores the configured kind produces visibly
 * different numbers.
 */

import type { Message } from '@scream-code/ltod';
import { describe, expect, it } from 'vitest';

import { DEFAULT_COMPACTION_CONFIG, DefaultCompactionStrategy } from '../../src/agent/compaction';
import type { ContextMessage } from '../../src/agent/context';
import type { Logger } from '../../src/logging';
import { estimateTokensForMessages, type TokenizerKind } from '../../src/utils/tokens';
import { testAgent } from './harness/agent';

const LONG = 'x'.repeat(400);
const HEURISTIC_LONG = 100;
const CL100K_LONG = 50;

function useTokenizer(ctx: ReturnType<typeof testAgent>, tokenizer: TokenizerKind): void {
  const config = ctx.agent.screamConfig;
  const alias = ctx.agent.config.modelAlias;
  if (config?.models === undefined || alias === undefined) {
    throw new Error('test agent has no model alias to configure');
  }
  const model = config.models[alias];
  if (model === undefined) throw new Error(`test agent has no alias "${alias}"`);
  config.models[alias] = { ...model, tokenizer };
}

function estimate(message: Message, tokenizer: TokenizerKind): number {
  return estimateTokensForMessages([message], tokenizer);
}

function captureLogger(): { logger: Logger; entries: { message: string; payload?: unknown }[] } {
  const entries: { message: string; payload?: unknown }[] = [];
  const logger: Logger = {
    error: () => {},
    warn: () => {},
    info: () => {},
    debug: (message, payload) => {
      entries.push({ message, payload });
    },
    createChild: () => logger,
  };
  return { logger, entries };
}

function assistantText(text: string): Message {
  return { role: 'assistant', content: [{ type: 'text', text }], toolCalls: [] };
}

describe('context gauge uses the configured tokenizer', () => {
  it('undo() subtracts heuristic counts for a heuristic session', () => {
    const ctx = testAgent();
    ctx.configure();
    useTokenizer(ctx, 'heuristic');
    ctx.appendAssistantTextWithUsage(1, LONG, 1_000);
    const [user, assistant] = ctx.agent.context.history as [ContextMessage, ContextMessage];
    expect(ctx.agent.context.tokenCount).toBe(1_000);

    ctx.agent.context.undo(1);

    const expected =
      1_000 - estimate(user, 'heuristic') - estimate(assistant, 'heuristic');
    expect(ctx.agent.context.tokenCount).toBe(expected);
    // Pre-tokenizer behavior: role overhead (1) + 18 ASCII chars (5) for the
    // prompt, role overhead (3) + 100 for the 400-char run.
    expect(ctx.agent.context.tokenCount).toBe(891);
  });

  it('undo() subtracts exact counts for the default cl100k session', () => {
    const ctx = testAgent();
    ctx.configure();
    useTokenizer(ctx, 'cl100k');
    ctx.appendAssistantTextWithUsage(1, LONG, 1_000);
    const [user, assistant] = ctx.agent.context.history as [ContextMessage, ContextMessage];

    ctx.agent.context.undo(1);

    expect(ctx.agent.context.tokenCount).toBe(
      1_000 - estimate(user, 'cl100k') - estimate(assistant, 'cl100k'),
    );
    expect(ctx.agent.context.tokenCount).not.toBe(891);
  });

  it('edit_message adjusts the gauge with the configured tokenizer', () => {
    const ctx = testAgent();
    ctx.configure();
    useTokenizer(ctx, 'heuristic');
    ctx.appendAssistantTextWithUsage(1, LONG, 1_000);
    const assistant = ctx.agent.context.history[1]!;
    const replacement = [{ type: 'text' as const, text: 'y'.repeat(100) }];

    ctx.agent.context.applyMessageEdit(assistant.id!, replacement);

    const before = 1_000;
    const expected =
      before -
      estimate(assistant, 'heuristic') +
      estimate({ ...assistant, content: replacement }, 'heuristic');
    expect(ctx.agent.context.tokenCount).toBe(expected);
    expect(ctx.agent.context.tokenCount).toBe(925);
  });

  it('open-step cleanup subtracts with the configured tokenizer', () => {
    const ctx = testAgent();
    ctx.configure();
    useTokenizer(ctx, 'heuristic');
    const user: ContextMessage = {
      role: 'user',
      content: [{ type: 'text', text: 'prompt' }],
      toolCalls: [],
    };
    const thinkingOnly: ContextMessage = {
      role: 'assistant',
      content: [{ type: 'think', think: LONG }],
      toolCalls: [],
    };
    ctx.agent.context.restore({
      history: [user, thinkingOnly],
      tokenCount: 1_000,
      tokenCountCoveredMessageCount: 2,
      openSteps: new Map([['interrupted', thinkingOnly]]),
      pendingToolResultIds: new Set(),
      deferredMessages: [],
    });

    ctx.agent.context.dropVacuousOpenMessages();

    expect(ctx.agent.context.tokenCount).toBe(
      1_000 - estimate(thinkingOnly, 'heuristic'),
    );
    expect(ctx.agent.context.tokenCount).toBe(897);
  });

  it('cached-prefix debug log reports the configured tokenizer count', () => {
    const { logger, entries } = captureLogger();
    const ctx = testAgent({ log: logger });
    ctx.configure();
    useTokenizer(ctx, 'heuristic');
    ctx.agent.context.appendUserMessage([{ type: 'text', text: 'one' }]);
    ctx.agent.context.appendMessage(assistantText('two'));
    ctx.agent.context.appendUserMessage([{ type: 'text', text: LONG }]);
    ctx.agent.context.appendMessage(assistantText('between'));
    ctx.agent.context.messagesForLLM();

    ctx.agent.context.appendUserMessage([{ type: 'text', text: 'three' }]);
    const messages = ctx.agent.context.messagesForLLM();

    const hit = entries.find((entry) =>
      entry.message.startsWith('prefix-stability: provider prompt cache prefix hit'),
    );
    expect(hit).toBeDefined();
    const payload = hit?.payload as { cachedPrefixTokens?: number; stablePrefixLength: number };
    // The stable prefix is the four messages the first call already sent.
    expect(payload.stablePrefixLength).toBe(4);
    expect(payload.cachedPrefixTokens).toBe(
      estimateTokensForMessages(messages.slice(0, 4), 'heuristic'),
    );
  });
});

describe('compaction cut points use the configured tokenizer', () => {
  /** Alternating user/assistant history; each assistant carries the 400-char run. */
  function history(count: number): Message[] {
    return Array.from({ length: count }, (_, index) =>
      index % 2 === 0
        ? { role: 'user', content: [{ type: 'text', text: 'prompt' }], toolCalls: [] }
        : assistantText(LONG),
    ) as Message[];
  }

  function strategy(
    tokenizer: () => TokenizerKind,
    maxSize = 1_000_000,
  ): DefaultCompactionStrategy {
    return new DefaultCompactionStrategy(
      () => maxSize,
      {
        ...DEFAULT_COMPACTION_CONFIG,
        // Tight enough that the tail budget is reached well before the
        // message-count caps, so the cut point follows token math.
        maxRecentTokens: 500,
      },
      tokenizer,
    );
  }

  it('computeCompactCount measures the preserved tail with the getter', () => {
    const messages = history(12);
    const heuristic = strategy(() => 'heuristic').computeCompactCount(messages, 'auto');
    const cl100k = strategy(() => 'cl100k').computeCompactCount(messages, 'auto');

    expect(heuristic).toMatchInlineSnapshot(`4`);
    expect(cl100k).toMatchInlineSnapshot(`2`);
    expect(heuristic).not.toBe(cl100k);
    // Omitted getter (direct construction by a host/test) keeps the heuristic.
    const legacy = new DefaultCompactionStrategy(() => 1_000_000, {
      ...DEFAULT_COMPACTION_CONFIG,
      maxRecentTokens: 500,
    }).computeCompactCount(messages, 'auto');
    expect(legacy).toBe(heuristic);
  });

  it('reduceCompactOnOverflow measures reclaimed tokens with the getter', () => {
    const messages = history(12);
    const heuristic = strategy(() => 'heuristic', 2_000).reduceCompactOnOverflow(messages);
    const cl100k = strategy(() => 'cl100k', 2_000).reduceCompactOnOverflow(messages);

    expect(heuristic).toMatchInlineSnapshot(`10`);
    expect(cl100k).toMatchInlineSnapshot(`8`);
    expect(heuristic).not.toBe(cl100k);
  });
});

describe('micro-compaction uses the configured tokenizer', () => {
  function microHistory(): ContextMessage[] {
    return [
      { role: 'user', content: [{ type: 'text', text: 'prompt' }], toolCalls: [] },
      {
        role: 'assistant',
        content: [],
        toolCalls: [{ type: 'function', id: 'c1', name: 'Read', arguments: '{}' }],
      },
      { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: LONG.repeat(2) }], toolCalls: [] },
    ];
  }

  function session(tokenizer: TokenizerKind) {
    const ctx = testAgent();
    ctx.configure();
    useTokenizer(ctx, tokenizer);
    const history = microHistory();
    ctx.agent.context.restore({
      history,
      tokenCount: 1_000,
      tokenCountCoveredMessageCount: 0,
      openSteps: new Map(),
      pendingToolResultIds: new Set(),
      deferredMessages: [],
    });
    const micro = ctx.agent.microCompaction;
    micro.config.keepRecentMessages = 1;
    // The trailing tool result alone exceeds this budget on the heuristic
    // (200 tokens) but fits on cl100k (100 tokens).
    micro.config.keepRecentTokens = 150;
    micro.config.pruneMinReclaimTokens = 0;
    micro.config.minContentTokens = 50;
    micro.config.minContextUsageRatio = 0;
    micro.detect();
    return micro.compact(history);
  }

  it('advances the cutoff past a tail that only the configured scale calls oversized', () => {
    const heuristic = session('heuristic');
    const cl100k = session('cl100k');

    // Heuristic: the tail is over budget → the cutoff reaches past it and the
    // tool result is elided.
    expect(heuristic[2]?.content).toEqual([{ type: 'text', text: '[Old tool result content cleared]' }]);
    // cl100k: the same result fits the tail budget → nothing is elided. (Its
    // suffix-reclaim guard also declines the move, so the cutoff stays put.)
    expect(cl100k[2]?.content).toEqual([{ type: 'text', text: LONG.repeat(2) }]);
  });
});
