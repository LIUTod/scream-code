/**
 * Repaired tool arguments must not be silently indistinguishable from the
 * model's own words. When a provider stream breaks mid-call and the bracket
 * balancer reconstructs the arguments, the executed values are a best effort:
 * the result carries a note the model can see, and a clean parse carries no
 * note.
 */
import { emptyUsage } from '@scream-code/ltod';
import { describe, expect, it } from 'vitest';

import type { LoopLiveOnlyEvent, LoopRecordedEvent, LoopToolResultEvent } from '#/loop/events';
import type { LLM, LLMChatParams, LLMChatResponse } from '#/loop/llm';
import { parseToolCallArguments } from '#/loop/tool-call';
import { runTurn, type RunTurnInput } from '#/loop/run-turn';
import type { ExecutableTool } from '#/loop/types';
import { EchoTool } from './fixtures/tools';

const REPAIR_NOTE_FRAGMENT = 'reconstructed from a truncated provider stream';

describe('parseToolCallArguments: repair provenance', () => {
  it('leaves a clean parse unmarked', () => {
    expect(parseToolCallArguments('{"text":"hello"}')).toEqual({
      success: true,
      data: { text: 'hello' },
    });
  });

  it('marks a repaired parse and still returns the reconstructed object', () => {
    const parsed = parseToolCallArguments('{"text":"hello');
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error('expected repair to succeed');
    expect(parsed.data).toEqual({ text: 'hello' });
    expect(parsed.repaired).toBe(true);
  });

  it('leaves unrepairable garbage unmarked as a failure', () => {
    const parsed = parseToolCallArguments('not json at all');
    expect(parsed.success).toBe(false);
  });
});

function toolCall(id: string, args: string) {
  return { type: 'function' as const, id, name: 'echo', arguments: args };
}

function makeLLM(firstArgs: string): LLM {
  let calls = 0;
  return {
    systemPrompt: '',
    modelName: 'mock',
    isRetryableError: () => false,
    async chat(_params: LLMChatParams): Promise<LLMChatResponse> {
      calls += 1;
      return calls === 1
        ? { toolCalls: [toolCall('call_1', firstArgs)], usage: emptyUsage() }
        : { toolCalls: [], usage: emptyUsage() };
    },
  };
}

function makeInput(
  llm: LLM,
  tools: readonly ExecutableTool[],
  dispatchEvent: (event: LoopRecordedEvent | LoopLiveOnlyEvent) => Promise<void>,
): RunTurnInput {
  return {
    turnId: 't',
    signal: new AbortController().signal,
    llm,
    buildMessages: async () => [],
    dispatchEvent,
    tools,
    maxSteps: 10,
    maxRetryAttempts: 1,
  };
}

describe('runnable tool results carry the repair note', () => {
  async function collectToolResultEvent(firstArgs: string): Promise<LoopToolResultEvent> {
    const events: Array<LoopRecordedEvent | LoopLiveOnlyEvent> = [];
    const dispatchEvent: (event: LoopRecordedEvent | LoopLiveOnlyEvent) => Promise<void> = async (
      event,
    ) => {
      events.push(event);
    };
    const tool = new EchoTool();
    await runTurn(makeInput(makeLLM(firstArgs), [tool], dispatchEvent));

    const toolResult = events.find(
      (event): event is LoopToolResultEvent => event.type === 'tool.result',
    );
    if (toolResult === undefined) throw new Error('no tool.result event was dispatched');
    return toolResult;
  }

  it('appends the note when the arguments were reconstructed', async () => {
    const event = await collectToolResultEvent('{"text":"hello');
    const text = typeof event.result.output === 'string' ? event.result.output : '';
    expect(text).toContain('hello');
    expect(text).toContain(REPAIR_NOTE_FRAGMENT);
  });

  it('appends no note when the arguments parsed cleanly', async () => {
    const event = await collectToolResultEvent('{"text":"hello"}');
    const text = typeof event.result.output === 'string' ? event.result.output : '';
    expect(text).toBe('hello');
    expect(text).not.toContain(REPAIR_NOTE_FRAGMENT);
  });
});
