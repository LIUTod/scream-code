import {
  emptyUsage,
  type ChatProvider,
  type Message,
  type ModelCapability,
  type StreamedMessagePart,
  type ToolCall,
} from '@scream-code/ltod';
import { describe, expect, it } from 'vitest';

import { LtodLLM, type GenerateFn } from '../../src/agent/turn/ltod-llm';
import type { ToolCallDelta } from '../../src/loop';
import { SecretObfuscator } from '../../src/agent/secrets';

const provider: ChatProvider = {
  name: 'test',
  modelName: 'test-model',
  thinkingEffort: null,
  async generate() {
    throw new Error('generate should be injected by the test');
  },
  withThinking() {
    return this;
  },
};

describe('LtodLLM streaming tool-call deltas', () => {
  it('maps indexed argument deltas back to the provider tool call id', async () => {
    const deltas = await collectToolCallDeltas([
      {
        type: 'function',
        id: 'call_bash',
        name: 'Bash',
        arguments: null,
        _streamIndex: 0,
      },
      { type: 'tool_call_part', argumentsPart: '{"command"', index: 0 },
      { type: 'tool_call_part', argumentsPart: ':"pwd"}', index: 0 },
    ]);

    expect(deltas).toEqual([
      { toolCallId: 'call_bash', name: 'Bash' },
      { toolCallId: 'call_bash', name: 'Bash', argumentsPart: '{"command"' },
      { toolCallId: 'call_bash', name: 'Bash', argumentsPart: ':"pwd"}' },
    ]);
  });

  it('buffers indexed argument deltas until the provider tool call id is known', async () => {
    const deltas = await collectToolCallDeltas([
      { type: 'tool_call_part', argumentsPart: '{"command"', index: 0 },
      {
        type: 'function',
        id: 'call_bash',
        name: 'Bash',
        arguments: null,
        _streamIndex: 0,
      },
      { type: 'tool_call_part', argumentsPart: ':"pwd"}', index: 0 },
    ]);

    expect(deltas).toEqual([
      { toolCallId: 'call_bash', name: 'Bash' },
      { toolCallId: 'call_bash', name: 'Bash', argumentsPart: '{"command"' },
      { toolCallId: 'call_bash', name: 'Bash', argumentsPart: ':"pwd"}' },
    ]);
    expect(deltas.map((delta) => delta.toolCallId)).not.toContain('0');
  });

  it('uses the latest tool call identity for linear unindexed argument deltas', async () => {
    const deltas = await collectToolCallDeltas([
      {
        type: 'function',
        id: 'call_write',
        name: 'Write',
        arguments: null,
      },
      { type: 'tool_call_part', argumentsPart: '{"path"' },
      { type: 'tool_call_part', argumentsPart: ':"a.txt"}' },
    ]);

    expect(deltas).toEqual([
      { toolCallId: 'call_write', name: 'Write' },
      { toolCallId: 'call_write', name: 'Write', argumentsPart: '{"path"' },
      { toolCallId: 'call_write', name: 'Write', argumentsPart: ':"a.txt"}' },
    ]);
  });
});

describe('LtodLLM stream timing', () => {
  it('returns timing measured from provider request start to stream end', async () => {
    const generate: GenerateFn = async (
      _provider,
      _systemPrompt,
      _tools,
      _history,
      callbacks,
      options,
    ) => {
      options?.onRequestStart?.();
      await callbacks?.onMessagePart?.({ type: 'text', text: 'timed' });
      options?.onStreamEnd?.();
      return {
        id: 'response-1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'timed' }],
          toolCalls: [],
        },
        usage: emptyUsage(),
        finishReason: 'completed',
        rawFinishReason: 'stop',
      };
    };
    const llm = new LtodLLM({
      provider,
      modelName: 'test-model',
      systemPrompt: 'system',
      generate,
    });

    const response = await llm.chat({
      messages: [],
      tools: [],
      signal: new AbortController().signal,
    });

    expect(response.streamTiming).toMatchObject({
      firstTokenLatencyMs: expect.any(Number),
      streamDurationMs: expect.any(Number),
    });
    expect(response.streamTiming?.firstTokenLatencyMs).toBeGreaterThanOrEqual(0);
    expect(response.streamTiming?.streamDurationMs).toBeGreaterThanOrEqual(0);
  });
});

describe('LtodLLM completion budget', () => {
  it('applies the model context window as the completion cap', async () => {
    let appliedCap: number | undefined;
    let generatedProvider: ChatProvider | undefined;
    const providerWithBudget: ChatProvider = {
      ...provider,
      withMaxCompletionTokens(n: number) {
        appliedCap = n;
        return { ...this, withMaxCompletionTokens: this.withMaxCompletionTokens };
      },
    };
    const generate: GenerateFn = async (nextProvider) => {
      generatedProvider = nextProvider;
      return {
        id: 'response-1',
        message: { role: 'assistant', content: [], toolCalls: [] },
        usage: emptyUsage(),
        finishReason: 'completed',
        rawFinishReason: 'stop',
      };
    };
    const llm = new LtodLLM({
      provider: providerWithBudget,
      modelName: 'test-model',
      systemPrompt: 'system',
      capability: makeCapability(10000),
      completionBudgetConfig: { fallback: 32000 },
      generate,
    });

    await llm.chat({
      messages: [],
      tools: [],
      signal: new AbortController().signal,
    });

    expect(appliedCap).toBe(10000);
    expect(generatedProvider).not.toBe(providerWithBudget);
  });
});

async function collectToolCallDeltas(
  parts: readonly StreamedMessagePart[],
): Promise<ToolCallDelta[]> {
  const deltas: ToolCallDelta[] = [];
  const generate: GenerateFn = async (_provider, _systemPrompt, _tools, _history, callbacks) => {
    for (const part of parts) {
      await callbacks?.onMessagePart?.(part);
    }
    return {
      id: 'response-1',
      message: {
        role: 'assistant',
        content: [],
        toolCalls: parts
          .filter((part): part is ToolCall => isToolCall(part))
          .map((toolCall) => stripStreamIndex(toolCall)),
      },
      usage: emptyUsage(),
      finishReason: 'tool_calls',
      rawFinishReason: 'tool_calls',
    };
  };
  const llm = new LtodLLM({
    provider,
    modelName: 'test-model',
    systemPrompt: 'system',
    generate,
  });

  await llm.chat({
    messages: [],
    tools: [],
    signal: new AbortController().signal,
    onToolCallDelta: (delta) => deltas.push(delta),
  });

  return deltas;
}

function isToolCall(part: StreamedMessagePart): part is ToolCall {
  return part.type === 'function';
}

function stripStreamIndex(toolCall: ToolCall): ToolCall {
  const { _streamIndex: _, ...rest } = toolCall;
  return rest;
}

function makeCapability(maxContextTokens: number): ModelCapability {
  return {
    image_in: false,
    video_in: false,
    audio_in: false,
    thinking: false,
    tool_use: true,
    max_context_tokens: maxContextTokens,
  };
}

describe('LtodLLM secret obfuscation', () => {
  it('obfuscates outbound user text; keeps persisted assistant content as placeholder', async () => {
    const obf = new SecretObfuscator([
      { type: 'plain', content: 'mysecretvalue', mode: 'obfuscate' },
    ]);
    const placeholder = obf.obfuscate('mysecretvalue');

    let capturedHistory: Message[] | undefined;
    const generate: GenerateFn = async (_p, _s, _t, history) => {
      capturedHistory = history;
      return {
        id: 'response-1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: `echo ${placeholder}` }],
          toolCalls: [],
        },
        usage: emptyUsage(),
        finishReason: 'completed',
        rawFinishReason: 'stop',
      };
    };

    const llm = new LtodLLM({
      provider,
      modelName: 'test-model',
      systemPrompt: 'system',
      generate,
      obfuscator: obf,
    });

    const seenParts: string[] = [];
    await llm.chat({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'use mysecretvalue here' }], toolCalls: [] },
      ],
      tools: [],
      signal: new AbortController().signal,
      onTextPart: (part) => {
        seenParts.push(part.text);
      },
    });

    expect(capturedHistory).toBeDefined();
    const userText = (capturedHistory![0]!.content[0] as { text: string }).text;
    expect(userText).not.toContain('mysecretvalue');
    expect(userText).toContain(placeholder);
    // onTextPart receives placeholder (what gets persisted); the next
    // outbound pass leaves assistant messages untouched, so the model
    // sees a consistent placeholder history.
    expect(seenParts).toEqual([`echo ${placeholder}`]);
  });

  it('deobfuscates streaming text deltas so the TUI shows real secrets', async () => {
    const obf = new SecretObfuscator([
      { type: 'plain', content: 'mysecretvalue', mode: 'obfuscate' },
    ]);
    const placeholder = obf.obfuscate('mysecretvalue');

    const generate: GenerateFn = async (_p, _s, _t, _history, callbacks) => {
      await callbacks?.onMessagePart?.({ type: 'text', text: `echo ${placeholder}` });
      return {
        id: 'response-1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: `echo ${placeholder}` }],
          toolCalls: [],
        },
        usage: emptyUsage(),
        finishReason: 'completed',
        rawFinishReason: 'stop',
      };
    };

    const llm = new LtodLLM({
      provider,
      modelName: 'test-model',
      systemPrompt: 'system',
      generate,
      obfuscator: obf,
    });

    const seenDeltas: string[] = [];
    await llm.chat({
      messages: [],
      tools: [],
      signal: new AbortController().signal,
      onTextDelta: (delta) => {
        seenDeltas.push(delta);
      },
    });

    expect(seenDeltas).toEqual(['echo mysecretvalue']);
  });

  it('reassembles a placeholder split across two streaming text deltas', async () => {
    const obf = new SecretObfuscator([
      { type: 'plain', content: 'mysecretvalue', mode: 'obfuscate' },
    ]);
    const placeholder = obf.obfuscate('mysecretvalue');
    // Split the placeholder exactly in half: "#ABC" + "DEF#"
    const half = Math.floor(placeholder.length / 2);
    const firstHalf = placeholder.slice(0, half);
    const secondHalf = placeholder.slice(half);

    const generate: GenerateFn = async (_p, _s, _t, _history, callbacks) => {
      await callbacks?.onMessagePart?.({ type: 'text', text: `echo ${firstHalf}` });
      await callbacks?.onMessagePart?.({ type: 'text', text: `${secondHalf} done` });
      return {
        id: 'response-1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: `echo ${placeholder} done` }],
          toolCalls: [],
        },
        usage: emptyUsage(),
        finishReason: 'completed',
        rawFinishReason: 'stop',
      };
    };

    const llm = new LtodLLM({
      provider,
      modelName: 'test-model',
      systemPrompt: 'system',
      generate,
      obfuscator: obf,
    });

    const seenDeltas: string[] = [];
    await llm.chat({
      messages: [],
      tools: [],
      signal: new AbortController().signal,
      onTextDelta: (delta) => {
        seenDeltas.push(delta);
      },
    });

    // The first delta holds back the partial placeholder; the second
    // delta completes it and deobfuscation restores the real secret.
    expect(seenDeltas.join('')).toBe('echo mysecretvalue done');
  });

  it('deobfuscates streaming think deltas', async () => {
    const obf = new SecretObfuscator([
      { type: 'plain', content: 'mysecretvalue', mode: 'obfuscate' },
    ]);
    const placeholder = obf.obfuscate('mysecretvalue');

    const generate: GenerateFn = async (_p, _s, _t, _history, callbacks) => {
      await callbacks?.onMessagePart?.({ type: 'think', think: `planning ${placeholder}` });
      return {
        id: 'response-1',
        message: {
          role: 'assistant',
          content: [{ type: 'think', think: `planning ${placeholder}` }],
          toolCalls: [],
        },
        usage: emptyUsage(),
        finishReason: 'completed',
        rawFinishReason: 'stop',
      };
    };

    const llm = new LtodLLM({
      provider,
      modelName: 'test-model',
      systemPrompt: 'system',
      generate,
      obfuscator: obf,
    });

    const seenDeltas: string[] = [];
    await llm.chat({
      messages: [],
      tools: [],
      signal: new AbortController().signal,
      onThinkDelta: (delta) => {
        seenDeltas.push(delta);
      },
    });

    expect(seenDeltas).toEqual(['planning mysecretvalue']);
  });

  it('deobfuscates placeholders inside tool call arguments JSON', async () => {
    const obf = new SecretObfuscator([
      { type: 'plain', content: 'mysecretvalue', mode: 'obfuscate' },
    ]);
    const placeholder = obf.obfuscate('mysecretvalue');

    const generate: GenerateFn = async () => {
      return {
        id: 'response-1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'writing file' }],
          toolCalls: [
            {
              type: 'function',
              id: 'call_1',
              name: 'Write',
              arguments: JSON.stringify({ path: '/a', content: placeholder }),
            },
          ],
        },
        usage: emptyUsage(),
        finishReason: 'tool_calls',
        rawFinishReason: 'tool_calls',
      };
    };

    const llm = new LtodLLM({
      provider,
      modelName: 'test-model',
      systemPrompt: 'system',
      generate,
      obfuscator: obf,
    });

    const response = await llm.chat({
      messages: [],
      tools: [],
      signal: new AbortController().signal,
    });

    // response.toolCalls carries deobfuscated args so tool execution gets
    // the real secret value.
    expect(response.toolCalls[0]!.arguments).not.toBeNull();
    expect(JSON.parse(response.toolCalls[0]!.arguments!)).toEqual({
      path: '/a',
      content: 'mysecretvalue',
    });
  });

  it('passes messages through unchanged when obfuscator has no secrets', async () => {
    const obf = new SecretObfuscator([]);
    let capturedHistory: Message[] | undefined;
    const generate: GenerateFn = async (_p, _s, _t, history) => {
      capturedHistory = history;
      return {
        id: 'response-1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'echo mysecretvalue' }],
          toolCalls: [],
        },
        usage: emptyUsage(),
        finishReason: 'completed',
        rawFinishReason: 'stop',
      };
    };

    const llm = new LtodLLM({
      provider,
      modelName: 'test-model',
      systemPrompt: 'system',
      generate,
      obfuscator: obf,
    });

    const seenText: string[] = [];
    await llm.chat({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'use mysecretvalue here' }], toolCalls: [] },
      ],
      tools: [],
      signal: new AbortController().signal,
      onTextPart: (part) => {
        seenText.push(part.text);
      },
    });

    expect(capturedHistory).toBeDefined();
    const userText = (capturedHistory![0]!.content[0] as { text: string }).text;
    expect(userText).toBe('use mysecretvalue here');
    expect(seenText).toEqual(['echo mysecretvalue']);
  });
});
