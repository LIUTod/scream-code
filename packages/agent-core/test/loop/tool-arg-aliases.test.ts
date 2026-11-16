/**
 * Models spell arguments the way other tools do (`limit`, `file_path`, `-C` as
 * `context`). The schemas are closed objects, so each such call used to burn a
 * model step on a validation error. A tool may declare the spellings it accepts
 * and the loop applies them before validation.
 */
import { emptyUsage } from '@scream-code/ltod';
import { describe, expect, it } from 'vitest';

import type { LoopLiveOnlyEvent, LoopRecordedEvent, LoopToolResultEvent } from '#/loop/events';
import type { LLM, LLMChatResponse } from '#/loop/llm';
import { runTurn } from '#/loop/run-turn';
import type { ExecutableTool } from '#/loop/types';
import { EDIT_ARG_ALIASES, EditInputSchema } from '#/tools/builtin/file/edit';
import { GREP_ARG_ALIASES, GrepInputSchema } from '#/tools/builtin/file/grep';
import { READ_ARG_ALIASES, ReadInputSchema } from '#/tools/builtin/file/read';
import { WRITE_ARG_ALIASES, WriteInputSchema } from '#/tools/builtin/file/write';
import { compileToolArgsValidator, validateToolArgs } from '#/tools/args-validator';
import { renameArgAliases } from '#/tools/support/arg-aliases';
import { toInputJsonSchema } from '#/tools/support/input-schema';
import { EchoTool } from './fixtures/tools';

describe('renameArgAliases', () => {
  const aliases = { limit: 'n_lines', offset: 'line_offset' };

  it('renames an alias to its canonical key and drops the alias', () => {
    expect(renameArgAliases({ path: 'a', limit: 5 }, aliases)).toEqual({ path: 'a', n_lines: 5 });
  });

  it('leaves the canonical key alone and keeps the alias when both are present', () => {
    const args = { path: 'a', limit: 5, n_lines: 9 };
    expect(renameArgAliases(args, aliases)).toEqual(args);
  });

  it('returns the same object when nothing needs renaming', () => {
    const args = { path: 'a', n_lines: 5 };
    expect(renameArgAliases(args, aliases)).toBe(args);
  });
});

function validates(schema: Parameters<typeof toInputJsonSchema>[0], args: unknown): string | null {
  return validateToolArgs(
    compileToolArgsValidator(toInputJsonSchema(schema)),
    args as Parameters<typeof validateToolArgs>[1],
  );
}

describe('built-in tools accept the spellings models actually use', () => {
  it('Read: offset / limit / n / file_path', () => {
    const raw = { file_path: '/x', offset: 10, limit: 20 };
    expect(validates(ReadInputSchema, raw)).not.toBeNull();
    expect(validates(ReadInputSchema, renameArgAliases(raw, READ_ARG_ALIASES))).toBeNull();
    expect(
      validates(ReadInputSchema, renameArgAliases({ path: '/x', n: 5 }, READ_ARG_ALIASES)),
    ).toBeNull();
  });

  it('Grep: context / C / A / B', () => {
    for (const [alias, canonical] of [
      ['context', '-C'],
      ['C', '-C'],
      ['A', '-A'],
      ['B', '-B'],
    ] as const) {
      const raw = { pattern: 'x', [alias]: 2 };
      expect(validates(GrepInputSchema, raw)).not.toBeNull();
      const normalized = renameArgAliases(raw, GREP_ARG_ALIASES);
      expect(normalized).toEqual({ pattern: 'x', [canonical]: 2 });
      expect(validates(GrepInputSchema, normalized)).toBeNull();
    }
  });

  it('Edit and Write: file_path', () => {
    const edit = { file_path: '/x', old_string: 'a', new_string: 'b' };
    expect(validates(EditInputSchema, edit)).not.toBeNull();
    expect(validates(EditInputSchema, renameArgAliases(edit, EDIT_ARG_ALIASES))).toBeNull();

    const write = { file_path: '/x', content: 'c' };
    expect(validates(WriteInputSchema, write)).not.toBeNull();
    expect(validates(WriteInputSchema, renameArgAliases(write, WRITE_ARG_ALIASES))).toBeNull();
  });

  it('does not invent aliases: a genuinely unknown property is still rejected', () => {
    const normalized = renameArgAliases({ path: '/x', bogus: 1 }, READ_ARG_ALIASES);
    expect(validates(ReadInputSchema, normalized)).not.toBeNull();
  });
});

describe('the loop normalizes arguments before validation', () => {
  function llmCalling(args: string): LLM {
    let calls = 0;
    return {
      systemPrompt: '',
      modelName: 'mock',
      isRetryableError: () => false,
      async chat(): Promise<LLMChatResponse> {
        calls += 1;
        return calls === 1
          ? {
              toolCalls: [{ type: 'function', id: 'call_1', name: 'echo', arguments: args }],
              usage: emptyUsage(),
            }
          : { toolCalls: [], usage: emptyUsage() };
      },
    };
  }

  async function resultFor(tool: ExecutableTool, args: string): Promise<LoopToolResultEvent> {
    const events: Array<LoopRecordedEvent | LoopLiveOnlyEvent> = [];
    await runTurn({
      turnId: 't',
      signal: new AbortController().signal,
      llm: llmCalling(args),
      buildMessages: async () => [],
      dispatchEvent: async (event) => {
        events.push(event);
      },
      tools: [tool],
      maxSteps: 5,
      maxRetryAttempts: 1,
    });
    const result = events.find(
      (event): event is LoopToolResultEvent => event.type === 'tool.result',
    );
    if (result === undefined) throw new Error('no tool.result');
    return result;
  }

  it('runs a call whose argument only validates after normalization', async () => {
    const tool = Object.assign(new EchoTool(), {
      normalizeArgs: (args: Record<string, unknown>) =>
        renameArgAliases(args, { message: 'text' }),
    });
    const result = await resultFor(tool, '{"message":"hello"}');
    expect(result.result.isError).not.toBe(true);
    expect(result.result.output).toBe('hello');
  });

  it('without the hook the same call is rejected as before', async () => {
    const result = await resultFor(new EchoTool(), '{"message":"hello"}');
    expect(result.result.isError).toBe(true);
    const output = result.result.output;
    expect(typeof output === 'string' ? output : '').toContain('Invalid args');
  });

  it('a throwing normalizer never breaks the call: validation sees the original arguments', async () => {
    const tool = Object.assign(new EchoTool(), {
      normalizeArgs: () => {
        throw new Error('boom');
      },
    });
    const result = await resultFor(tool, '{"text":"hello"}');
    expect(result.result.isError).not.toBe(true);
    expect(result.result.output).toBe('hello');
  });
});
