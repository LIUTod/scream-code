/**
 * The fallback model in a turn: once a request hands over to it, the rest of
 * the turn stays on it, and each step reports the model that answered.
 */
import { APIStatusError, isRetryableGenerateError } from '@scream-code/ltod';
import { describe, expect, it } from 'vitest';

import { createLoopEventDispatcher, runTurn } from '../../src/loop/index';
import type { LLM, LLMChatResponse } from '../../src/loop/llm';
import { CollectingSink } from './fixtures/collecting-sink';
import { FakeLLM, makeEndTurnResponse, makeToolCall, makeToolUseResponse } from './fixtures/fake-llm';
import { RecordingContext } from './fixtures/recording-context';
import { EchoTool } from './fixtures/tools';

class Retryable extends FakeLLM {
  isRetryableError(error: unknown): boolean {
    return isRetryableGenerateError(error);
  }
}

describe('runTurn — fallback model', () => {
  it('keeps the rest of the turn on the fallback model and bills each step to it', async () => {
    let mainCalls = 0;
    const main: LLM = {
      systemPrompt: '',
      modelName: 'main',
      isRetryableError: (error) => isRetryableGenerateError(error),
      async chat(): Promise<LLMChatResponse> {
        mainCalls += 1;
        throw new APIStatusError(401, 'Invalid API key');
      },
    };
    const backup = new Retryable({
      modelName: 'backup',
      responses: [makeToolUseResponse([makeToolCall('echo', { text: 'hi' })]), makeEndTurnResponse('done')],
    });
    let resolves = 0;
    const answered: string[] = [];
    const context = new RecordingContext({});
    const sink = new CollectingSink({});
    const result = await runTurn({
      turnId: 'turn-1',
      signal: new AbortController().signal,
      llm: main,
      fallbackLlm: () => {
        resolves += 1;
        return backup;
      },
      buildMessages: context.buildMessages,
      dispatchEvent: createLoopEventDispatcher({
        appendTranscriptRecord: context.appendTranscriptRecord,
        emitLiveEvent: sink.emit,
      }),
      tools: [new EchoTool()],
      hooks: {
        afterStep: async ({ llm }) => {
          answered.push(llm.modelName);
          return undefined;
        },
      },
    });

    expect(result.stopReason).toBe('end_turn');
    // The session model failed once; the second step went straight to the fallback.
    expect(mainCalls).toBe(1);
    expect(resolves).toBe(1);
    expect(backup.callCount).toBe(2);
    expect(answered).toEqual(['backup', 'backup']);
  });
});
