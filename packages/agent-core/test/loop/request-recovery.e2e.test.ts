/**
 * Request recovery in a step: when the provider rejects the request because
 * of the message sequence itself, the loop normalizes the sequence, retries
 * once, and keeps the normalized projection for the rest of the turn. Media
 * recovery shares the same path, so its retry is pinned here too.
 */
import { APIStatusError, type Message } from '@scream-code/ltod';
import { describe, expect, it } from 'vitest';

import type { Logger, LogPayload } from '../../src/logging';
import { createLoopEventDispatcher, runTurn as runTurnImpl } from '../../src/loop/index';
import type { LLM, LLMChatParams, LLMChatResponse } from '../../src/loop/llm';
import { CollectingSink } from './fixtures/collecting-sink';
import { makeEndTurnResponse, makeToolCall, makeToolUseResponse } from './fixtures/fake-llm';
import { runTurn, runTurnExpectingThrow } from './fixtures/helpers';
import { RecordingContext } from './fixtures/recording-context';
import { EchoTool } from './fixtures/tools';

const STRUCTURE_ERROR = 'messages.1: text content blocks must be non-empty';

/** A history a strict endpoint refuses: a blank text block. */
function blankHistory(): Message[] {
  return [
    { role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] },
    { role: 'assistant', content: [{ type: 'text', text: ' ' }], toolCalls: [] },
    { role: 'user', content: [{ type: 'text', text: 'go on' }], toolCalls: [] },
  ];
}

function hasBlankText(messages: readonly Message[]): boolean {
  return messages.some((m) => m.content.some((p) => p.type === 'text' && p.text.trim() === ''));
}

function captureWarnings(): { logger: Logger; warnings: string[] } {
  const warnings: string[] = [];
  const noop = () => {};
  const logger = {
    error: noop,
    info: noop,
    debug: noop,
    warn: (message: string, _payload?: LogPayload) => {
      warnings.push(message);
    },
  } as unknown as Logger;
  return { logger, warnings };
}

describe('runTurn — request structure recovery', () => {
  it('normalizes the messages and retries once when the structure is rejected', async () => {
    const { logger, warnings } = captureWarnings();
    const { result, llm } = await runTurn({
      responses: [makeEndTurnResponse('unused'), makeEndTurnResponse('recovered')],
      llmThrowOnIndex: { index: 0, error: new APIStatusError(400, STRUCTURE_ERROR) },
      contextOptions: { messages: blankHistory() },
      log: logger,
    });

    expect(result.stopReason).toBe('end_turn');
    expect(llm.callCount).toBe(2);
    expect(hasBlankText(llm.calls[0]!.messages)).toBe(true);
    expect(hasBlankText(llm.calls[1]!.messages)).toBe(false);
    expect(warnings).toContain('request structure rejected - retrying with normalized messages');
  });

  it('keeps the repair for later steps of the same turn without failing again', async () => {
    const echo = new EchoTool();
    const { result, llm } = await runTurn({
      responses: [
        makeEndTurnResponse('unused'),
        makeToolUseResponse([makeToolCall('echo', { text: 'x' })]),
        makeEndTurnResponse('done'),
      ],
      llmThrowOnIndex: { index: 0, error: new APIStatusError(400, STRUCTURE_ERROR) },
      tools: [echo],
      contextOptions: { messages: blankHistory() },
    });

    expect(result.stopReason).toBe('end_turn');
    expect(llm.callCount).toBe(3);
    // Step 2 sends the repaired sequence straight away.
    expect(hasBlankText(llm.calls[2]!.messages)).toBe(false);
  });

  it('does not touch a request that was not rejected', async () => {
    const { llm } = await runTurn({
      responses: [makeEndTurnResponse('fine')],
      contextOptions: { messages: blankHistory() },
    });
    expect(hasBlankText(llm.calls[0]!.messages)).toBe(true);
  });

  it('rethrows other 400s unchanged', async () => {
    const other = new APIStatusError(400, 'invalid model id');
    const { error, llm } = await runTurnExpectingThrow({
      responses: [makeEndTurnResponse('never')],
      llmThrowOnIndex: { index: 0, error: other },
      contextOptions: { messages: blankHistory() },
    });
    expect(error).toBe(other);
    expect(llm.callCount).toBe(1);
  });

  it('tries the repair only once: a second structural rejection is thrown', async () => {
    const context = new RecordingContext({ messages: blankHistory() });
    const calls: LLMChatParams[] = [];
    const rejecting: LLM = {
      systemPrompt: 'fake system prompt',
      modelName: 'fake-model',
      chat: async (params: LLMChatParams): Promise<LLMChatResponse> => {
        calls.push(params);
        throw new APIStatusError(400, STRUCTURE_ERROR);
      },
    };
    const sink = new CollectingSink();
    await expect(
      runTurnImpl({
        turnId: 'turn-1',
        signal: new AbortController().signal,
        llm: rejecting,
        buildMessages: context.buildMessages,
        dispatchEvent: createLoopEventDispatcher({
          appendTranscriptRecord: context.appendTranscriptRecord,
          emitLiveEvent: sink.emit,
        }),
      }),
    ).rejects.toThrow(STRUCTURE_ERROR);
    expect(calls).toHaveLength(2);
  });
});

describe('runTurn — media recovery (shared retry path)', () => {
  it('retries a too-large request with media degraded', async () => {
    const { logger, warnings } = captureWarnings();
    const { result, llm } = await runTurn({
      responses: [makeEndTurnResponse('unused'), makeEndTurnResponse('ok')],
      llmThrowOnIndex: { index: 0, error: new APIStatusError(413, 'request entity too large') },
      log: logger,
    });
    expect(result.stopReason).toBe('end_turn');
    expect(llm.callCount).toBe(2);
    expect(warnings).toContain('request too large - retrying with media degraded');
  });
});
