/**
 * The generic execution deadline: a tool that never resolves and never checks
 * the abort signal must not hold the turn forever. The deadline aborts the
 * call's own signal (never the turn's), and tools that manage their own
 * lifetime (`longRunning`) are exempt.
 */
import { emptyUsage } from '@scream-code/ltod';
import { describe, expect, it } from 'vitest';

import type { LoopLiveOnlyEvent, LoopRecordedEvent, LoopToolResultEvent } from '#/loop/events';
import { runTurn, type RunTurnInput } from '#/loop/run-turn';
import type {
  ExecutableTool,
  ExecutableToolContext,
  ExecutableToolResult,
  ToolExecution,
} from '#/loop/types';
import type { LLM, LLMChatParams, LLMChatResponse } from '#/loop/llm';

function toolCall(id: string, args: string) {
  return { type: 'function' as const, id, name: 'hang', arguments: args };
}

function makeLLM(callCount: number): LLM {
  let calls = 0;
  return {
    systemPrompt: '',
    modelName: 'mock',
    isRetryableError: () => false,
    async chat(_params: LLMChatParams): Promise<LLMChatResponse> {
      calls += 1;
      return calls <= callCount
        ? { toolCalls: [toolCall(`call_${String(calls)}`, '{}')], usage: emptyUsage() }
        : { toolCalls: [], usage: emptyUsage() };
    },
  };
}

function makeInput(
  llm: LLM,
  tools: readonly ExecutableTool[],
  toolDeadlineMs: number,
  turnSignal: AbortSignal,
  dispatchEvent: (event: LoopRecordedEvent | LoopLiveOnlyEvent) => Promise<void>,
): RunTurnInput {
  return {
    turnId: 't',
    signal: turnSignal,
    llm,
    buildMessages: async () => [],
    dispatchEvent,
    tools,
    maxSteps: 10,
    maxRetryAttempts: 1,
    toolDeadlineMs,
  };
}

/** Never settles, never inspects any signal. */
function hungTool(options: { longRunning?: boolean } = {}): ExecutableTool {
  const tool: ExecutableTool = {
    name: 'hang',
    description: 'Hangs forever and ignores every signal.',
    longRunning: options.longRunning === true ? true : undefined,
    parameters: { type: 'object', properties: {}, required: [] },
    resolveExecution(_input: unknown): ToolExecution {
      return {
        approvalRule: 'hang',
        execute: () =>
          new Promise<ExecutableToolResult>(() => {
            // Never resolves; deliberately does not listen to the signal.
          }),
      };
    },
  };
  return tool;
}

/** Hangs but honours the per-call signal: throws when the deadline aborts. */
function deadlineAwareTool(): ExecutableTool {
  return {
    name: 'hang',
    description: 'Hangs until aborted, then rethrows.',
    parameters: { type: 'object', properties: {}, required: [] },
    resolveExecution(_input: unknown): ToolExecution {
      return {
        approvalRule: 'hang',
        execute: (ctx: ExecutableToolContext) =>
          new Promise<ExecutableToolResult>((_resolve, reject) => {
            ctx.signal.addEventListener('abort', () => {
              reject(ctx.signal.reason);
            }, { once: true });
          }),
      };
    },
  };
}

async function collectToolResultEvent(
  tool: ExecutableTool,
  toolDeadlineMs: number,
  abortTurnAfterMs: number | undefined,
  explicitTurnSignal?: AbortSignal,
): Promise<LoopToolResultEvent> {
  const events: Array<LoopRecordedEvent | LoopLiveOnlyEvent> = [];
  const dispatchEvent: (event: LoopRecordedEvent | LoopLiveOnlyEvent) => Promise<void> = async (
    event,
  ) => {
    events.push(event);
  };

  const llm = makeLLM(1);
  const turnSignal: AbortController | undefined =
    explicitTurnSignal === undefined && abortTurnAfterMs !== undefined
      ? new AbortController()
      : undefined;
  if (turnSignal !== undefined) {
    setTimeout(() => {
      turnSignal.abort();
    }, abortTurnAfterMs);
  }
  const turnSignalValue = explicitTurnSignal ?? turnSignal?.signal ?? new AbortController().signal;
  const input = makeInput(llm, [tool], toolDeadlineMs, turnSignalValue, dispatchEvent);

  await runTurn(input);
  const toolResult = events.find(
    (event): event is LoopToolResultEvent => event.type === 'tool.result',
  );
  if (toolResult === undefined) throw new Error('no tool.result event was dispatched');
  return toolResult;
}

describe('deadline vs user-abort attribution', () => {
  /**
   * A user interrupt must never be billed to the tool's failure streak.
   * Ordering is deterministic: the deadline timer (fixed offset from call
   * start) always fires before the grace sentinel (abort + 2s) resolves, so
   * the unguarded `fired` flag would be read as true and misattribute the
   * call as `timeout`.
   */
  it('keeps the abort attribution when the stop lands mid-call, before the deadline timer', async () => {
    const event = await collectToolResultEvent(hungTool(), 100, 20);

    expect(event.result.isError).toBe(true);
    if (event.result.isError !== true) throw new Error('expected an error result');
    expect(event.result.code).toBe('aborted');
    const text = typeof event.result.output === 'string' ? event.result.output : '';
    expect(text).not.toContain('execution deadline');
  }, 15_000);

  it('keeps the deadline attribution when nothing stopped the call', async () => {
    const event = await collectToolResultEvent(hungTool(), 50, undefined);

    expect(event.result.isError).toBe(true);
    if (event.result.isError !== true) throw new Error('expected an error result');
    expect(event.result.code).toBe('timeout');
  }, 15_000);
});

describe('tool execution deadline', () => {
  it('ends a hung tool with a timeout result and counts it as a tool defect', async () => {
    const event = await collectToolResultEvent(hungTool(), 50, undefined);

    expect(event.result.isError).toBe(true);
    if (event.result.isError !== true) throw new Error('expected an error result');
    expect(event.result.code).toBe('timeout');
    const text = typeof event.result.output === 'string' ? event.result.output : '';
    expect(text).toContain('execution deadline');
  }, 15_000);

  it('does not end a longRunning tool; the turn abort still reaches it', async () => {
    const event = await collectToolResultEvent(hungTool({ longRunning: true }), 50, 120);

    expect(event.result.isError).toBe(true);
    if (event.result.isError !== true) throw new Error('expected an error result');
    expect(event.result.code).toBe('aborted');
    const text = typeof event.result.output === 'string' ? event.result.output : '';
    expect(text).not.toContain('execution deadline');
  }, 15_000);

  it('reports the deadline through the tool when the tool honours its signal', async () => {
    const event = await collectToolResultEvent(deadlineAwareTool(), 50, undefined);

    expect(event.result.isError).toBe(true);
    if (event.result.isError !== true) throw new Error('expected an error result');
    // The tool threw its own abort — the loop classifies that as a failure,
    // not as a user abort, and the reason text names the deadline.
    expect(event.result.code).toBe('failed');
    const text = typeof event.result.output === 'string' ? event.result.output : '';
    expect(text).toContain('execution deadline (50ms)');
  }, 15_000);
});
