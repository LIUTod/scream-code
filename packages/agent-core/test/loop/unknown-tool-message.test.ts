/**
 * A call to a tool that is not in the table used to be answered with a bare
 * `Tool "X" not found`, which tells the model nothing about what it can use
 * instead. The reply keeps that prefix (callers match on it) and adds the
 * closest spelling, or the tools that do exist.
 */
import { emptyUsage } from '@scream-code/ltod';
import { describe, expect, it } from 'vitest';

import type { LoopLiveOnlyEvent, LoopRecordedEvent, LoopToolResultEvent } from '#/loop/events';
import type { LLM, LLMChatResponse } from '#/loop/llm';
import { runTurn } from '#/loop/run-turn';
import { describeUnknownTool } from '#/loop/tool-call';
import type { ExecutableTool } from '#/loop/types';
import { EchoTool } from './fixtures/tools';

function named(name: string): ExecutableTool {
  return Object.assign(new EchoTool(), { name });
}

describe('describeUnknownTool', () => {
  it('keeps the original prefix', () => {
    expect(describeUnknownTool('Bash', [named('Read')])).toMatch(/^Tool "Bash" not found/);
  });

  it('points at the same tool spelled differently (case, underscores, hyphens)', () => {
    expect(describeUnknownTool('bash', [named('Bash'), named('Read')])).toContain('Did you mean "Bash"?');
    expect(describeUnknownTool('read_file', [named('ReadFile')])).toContain('Did you mean "ReadFile"?');
    expect(describeUnknownTool('web-search', [named('WebSearch')])).toContain(
      'Did you mean "WebSearch"?',
    );
  });

  it('lists the tools that exist when nothing is close', () => {
    const text = describeUnknownTool('Bash', [named('Read'), named('Grep')]);
    expect(text).toContain('Read');
    expect(text).toContain('Grep');
    expect(text).not.toContain('Did you mean');
  });

  it('says so when no tools are available at all', () => {
    expect(describeUnknownTool('Bash', [])).toContain('No tools are available');
    expect(describeUnknownTool('Bash', undefined)).toContain('No tools are available');
  });

  it('caps a long tool list instead of flooding the model', () => {
    const many = Array.from({ length: 80 }, (_, i) => named(`Tool${String(i).padStart(2, '0')}`));
    const text = describeUnknownTool('Bash', many);
    expect(text).toContain('Tool00');
    expect(text).not.toContain('Tool79');
    expect(text).toMatch(/and 50 more/);
  });
});

describe('the loop reports an unknown tool with that guidance', () => {
  it('rejects the call and the result carries the suggestion', async () => {
    let calls = 0;
    const llm: LLM = {
      systemPrompt: '',
      modelName: 'mock',
      isRetryableError: () => false,
      async chat(): Promise<LLMChatResponse> {
        calls += 1;
        return calls === 1
          ? {
              toolCalls: [{ type: 'function', id: 'c1', name: 'ECHO', arguments: '{"text":"x"}' }],
              usage: emptyUsage(),
            }
          : { toolCalls: [], usage: emptyUsage() };
      },
    };
    const events: Array<LoopRecordedEvent | LoopLiveOnlyEvent> = [];
    await runTurn({
      turnId: 't',
      signal: new AbortController().signal,
      llm,
      buildMessages: async () => [],
      dispatchEvent: async (event) => {
        events.push(event);
      },
      tools: [new EchoTool()],
      maxSteps: 5,
      maxRetryAttempts: 1,
    });
    const result = events.find(
      (event): event is LoopToolResultEvent => event.type === 'tool.result',
    );
    expect(result?.result.isError).toBe(true);
    const output = result?.result.output;
    expect(typeof output === 'string' ? output : '').toMatch(
      /^Tool "ECHO" not found\. Did you mean "echo"\?/,
    );
  });
});

describe('a call to a tool that is not offered yet but can be enabled', () => {
  it('runs in the same step once the host enables it', async () => {
    let calls = 0;
    const llm: LLM = {
      systemPrompt: '',
      modelName: 'mock',
      isRetryableError: () => false,
      async chat(): Promise<LLMChatResponse> {
        calls += 1;
        return calls === 1
          ? {
              // As a model does: enable a group and call one of its tools at once.
              toolCalls: [
                { type: 'function', id: 'c1', name: 'echo', arguments: '{"text":"first"}' },
                { type: 'function', id: 'c2', name: 'Later', arguments: '{"text":"x"}' },
              ],
              usage: emptyUsage(),
            }
          : { toolCalls: [], usage: emptyUsage() };
      },
    };
    const events: Array<LoopRecordedEvent | LoopLiveOnlyEvent> = [];
    const asked: string[] = [];
    await runTurn({
      turnId: 't',
      signal: new AbortController().signal,
      llm,
      buildMessages: async () => [],
      dispatchEvent: async (event) => {
        events.push(event);
      },
      tools: [new EchoTool()],
      enableMissingTool: (name) => {
        asked.push(name);
        return name === 'Later' ? [new EchoTool(), named('Later')] : undefined;
      },
      maxSteps: 5,
      maxRetryAttempts: 1,
    });
    expect(asked).toEqual(['Later']);
    const results = events.filter((event): event is LoopToolResultEvent => event.type === 'tool.result');
    expect(results.map((event) => event.result.isError ?? false)).toEqual([false, false]);
  });
});
