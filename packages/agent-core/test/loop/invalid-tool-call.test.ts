/**
 * Invalid-tool-call circuit breaker: a model that keeps emitting calls that
 * fail preflight (unknown tool / malformed args) would otherwise burn steps
 * and tokens forever, bounded only by maxSteps. The breaker stops the turn
 * after a run of steps whose tool calls were ALL rejected; any step with at
 * least one runnable call resets the counter, so healthy turns never trip it.
 */
import { emptyUsage } from '@scream-code/ltod';
import { describe, expect, it } from 'vitest';

import { ToolCallDeduplicator } from '#/agent/turn/tool-dedup';
import type { LoopEventDispatcher } from '#/loop/events';
import type { LLM, LLMChatParams, LLMChatResponse } from '#/loop/llm';
import { runTurn, type RunTurnInput } from '#/loop/run-turn';
import type { ExecutableTool, LoopHooks } from '#/loop/types';
import { EchoTool } from './fixtures/tools';

const NO_SUCH_TOOL = 'no_such_tool';

function toolCall(id: string, name = NO_SUCH_TOOL, args = '{}') {
  return { type: 'function' as const, id, name, arguments: args };
}

function rejectedStep(id: string): LLMChatResponse {
  return { toolCalls: [toolCall(id)], usage: emptyUsage() };
}

function finalStep(): LLMChatResponse {
  return { toolCalls: [], usage: emptyUsage() };
}

function makeLLM(sequence: Array<() => LLMChatResponse>): LLM {
  let calls = 0;
  return {
    systemPrompt: '',
    modelName: 'mock',
    isRetryableError: () => false,
    async chat(_params: LLMChatParams): Promise<LLMChatResponse> {
      const next = sequence[Math.min(calls, sequence.length - 1)]!;
      calls += 1;
      return next();
    },
  };
}

function makeInput(
  llm: LLM,
  options?: {
    tools?: readonly ExecutableTool[];
    maxSteps?: number;
    hooks?: LoopHooks;
    dispatchEvent?: LoopEventDispatcher;
  },
): RunTurnInput {
  return {
    turnId: 't',
    signal: new AbortController().signal,
    llm,
    buildMessages: async () => [],
    dispatchEvent: options?.dispatchEvent ?? (async () => {}),
    tools: options?.tools ?? [],
    hooks: options?.hooks,
    maxSteps: options?.maxSteps ?? 10,
    maxRetryAttempts: 1,
  };
}

describe('invalid-tool-call circuit breaker', () => {
  it('stops the turn after 8 consecutive all-rejected steps (instead of running to maxSteps)', async () => {
    // 12 all-rejected steps available; the breaker must stop at 8, well before
    // the maxSteps=10 bound, so a broken model stops burning tokens.
    const sequence = Array.from({ length: 12 }, (_, i) => () => rejectedStep(`c${i}`));
    const result = await runTurn(makeInput(makeLLM(sequence)));

    expect(result.stopReason).toBe('end_turn');
    expect(result.steps).toBe(8);
  });

  it('allows up to 4 consecutive all-rejected steps before a normal end', async () => {
    // 4 rejected steps (< 5) then a clean end_turn: the breaker must not trip.
    const sequence = [
      () => rejectedStep('c0'),
      () => rejectedStep('c1'),
      () => rejectedStep('c2'),
      () => rejectedStep('c3'),
      finalStep,
    ];
    const result = await runTurn(makeInput(makeLLM(sequence)));

    expect(result.stopReason).toBe('end_turn');
    expect(result.steps).toBe(5);
  });

  it('resets the counter when a step has a runnable call (mixed batch)', async () => {
    // 3 rejected steps, then a step mixing one rejected + one runnable call
    // (counter resets to 0), then 4 more all-rejected steps (< 8 from reset),
    // then a clean end. The breaker must not trip.
    const echo = new EchoTool();
    const sequence = [
      () => rejectedStep('c0'),
      () => rejectedStep('c1'),
      () => rejectedStep('c2'),
      () => ({
        toolCalls: [toolCall('m0', NO_SUCH_TOOL), toolCall('m1', 'echo', '{"text":"hi"}')],
        usage: emptyUsage(),
      }),
      () => rejectedStep('c3'),
      () => rejectedStep('c4'),
      () => rejectedStep('c5'),
      () => rejectedStep('c6'),
      finalStep,
    ];
    const result = await runTurn(makeInput(makeLLM(sequence), { tools: [echo] }));

    expect(result.stopReason).toBe('end_turn');
    expect(result.steps).toBe(9);
    // The runnable echo call in the mixed batch actually executed.
    expect(echo.calls).toHaveLength(1);
  });

  it('wires rejected calls into the repeat breaker end-to-end (reminder appended to the rejection output)', async () => {
    // Full wiring: loop rejected branch -> onToolCallRejected hook ->
    // deduper.registerSkipped -> 3-streak reminder appended to the output the
    // model sees. Re-issuing the same invalid call 3 times must surface
    // REMINDER_TEXT_1 in the third tool.result.
    const deduper = new ToolCallDeduplicator();
    const toolResults: string[] = [];
    const sequence = [
      () => rejectedStep('c0'),
      () => rejectedStep('c1'),
      () => rejectedStep('c2'),
      finalStep,
    ];
    const result = await runTurn(
      makeInput(makeLLM(sequence), {
        hooks: {
          beforeStep: async () => {
            deduper.beginStep();
          },
          afterStep: async () => {
            deduper.endStep();
          },
          onToolCallRejected: async ({ toolCallId, toolName, args, rawArguments }) =>
            deduper.registerSkipped(toolCallId, toolName, args, rawArguments),
        },
        dispatchEvent: async (event) => {
          if (event.type === 'tool.result') {
            toolResults.push(String(event.result.output ?? ''));
          }
        },
      }),
    );

    expect(result.stopReason).toBe('end_turn');
    expect(result.steps).toBe(4);
    // The third all-rejected step's output carries the 3-streak reminder.
    expect(toolResults.some((output) => output.includes('You are repeating the exact same tool call'))).toBe(true);
  });
});
