import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildTraceCells } from '#/utils/trace/trace-builder';

function withWire(lines: Array<Record<string, unknown>>): string {
  const dir = mkdtempSync(join(tmpdir(), 'trace-test-'));
  const path = join(dir, 'wire.jsonl');
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  return path;
}

/** Wrap a loop event in the wire record envelope. */
function loop(
  type: string,
  fields: Record<string, unknown> = {},
  time?: number,
): Record<string, unknown> {
  return { type: 'context.append_loop_event', event: { type, ...fields }, ...(time ? { time } : {}) };
}

const T0 = 1_700_000_000_000;

describe('buildTraceCells', () => {
  it('throws when the wire file is missing', () => {
    expect(() => buildTraceCells({ wirePath: '/nonexistent/wire.jsonl' })).toThrow();
  });

  it('maps user prompts, request headers, steps, tools, usage and compaction', () => {
    const wirePath = withWire([
      { type: 'turn.prompt', input: [{ type: 'text', text: '你好，帮我查一下' }], time: T0 },
      { type: 'request.header', provider: 'test-provider', model: 'test-model', activeTools: [{ name: 'bash' }, { name: 'read' }], time: T0 + 1000 },
      loop('step.begin', { uuid: 's1', turnId: '0', step: 1 }, T0 + 2000),
      loop('block.start', { blockType: 'thinking' }, T0 + 2100),
      loop('content.part', { part: { type: 'thinking', text: '我需要先用工具' } }, T0 + 2200),
      loop('block.end', {}, T0 + 2300),
      loop('block.start', { blockType: 'text' }, T0 + 2400),
      loop('content.part', { part: { type: 'text', text: '我来帮你查' } }, T0 + 2500),
      loop('block.end', {}, T0 + 2600),
      loop('tool.call', { toolCallId: 't1', name: 'bash', args: { command: 'ls' } }, T0 + 2700),
      loop('tool.result', { toolCallId: 't1', result: { result: 'file1.txt' } }, T0 + 2800),
      loop('step.end', { usage: { inputOther: 100, inputCacheRead: 50, inputCacheCreation: 10, output: 20 }, llmFirstTokenLatencyMs: 1200, llmStreamDurationMs: 3400, reportedModel: 'deepseek-v4', finishReason: 'tool_calls' }, T0 + 3000),
      { type: 'full_compaction.begin', reason: '上下文过大', instruction: '保留关键上下文', source: 'manual', time: T0 + 4000 },
    ]);

    const cells = buildTraceCells({ wirePath });
    const kinds = cells.map((c) => c.kind);

    expect(kinds).toEqual(['user', 'system', 'message', 'tool', 'compacted']);

    const user = cells[0]!;
    expect(user.text).toContain('你好');
    expect(user.opensTurn).toBe(true);
    expect(user.inputDetail).toContain('帮我查一下');

    const system = cells[1]!;
    expect(system.text).toContain('test-model');
    expect(system.inputDetail).toContain('bash');

    const message = cells[2]!;
    expect(message.text).toContain('我来帮你查');
    expect(message.thinkingDetail).toContain('先用工具');
    expect(message.outputDetail).toContain('帮你查');
    expect(message.input).toBe(100);
    expect(message.cacheRead).toBe(50);
    expect(message.cacheWrite).toBe(10);
    expect(message.output).toBe(20);
    // step.end timing/model/finish facts.
    expect(message.ttftMs).toBe(1200);
    expect(message.decodingMs).toBe(3400);
    expect(message.model).toBe('deepseek-v4');
    expect(message.finishReason).toBe('tool_calls');
    // step.begin → step.end duration = 1s
    expect(message.timeSeconds).toBe(1);
    expect(message.startedAt).toBe(T0 + 2000);
    expect(message.endAt).toBe(T0 + 3000);

    const tool = cells[3]!;
    expect(tool.text).toContain('bash');
    expect(tool.inputDetail).toContain('ls');
    expect(tool.result).toContain('file1.txt');
    expect(tool.isError).toBe(false);

    const compacted = cells[4]!;
    expect(compacted.text).toContain('压缩');
    expect(compacted.text).toContain('上下文过大');
    expect(compacted.inputDetail).toContain('保留关键上下文');
    expect(compacted.result).toContain('manual');
  });

  it('marks failed tool results as errors', () => {
    const wirePath = withWire([
      { type: 'turn.prompt', input: [{ type: 'text', text: 'x' }], time: T0 },
      loop('step.begin', { uuid: 's1', turnId: '0', step: 1 }, T0 + 100),
      loop('tool.call', { toolCallId: 't1', name: 'bash', args: 'ls' }, T0 + 200),
      loop('tool.result', { toolCallId: 't1', result: { isError: true, output: 'boom' } }, T0 + 300),
      loop('step.end', {}, T0 + 400),
    ]);
    const cells = buildTraceCells({ wirePath });
    const tool = cells.find((c) => c.kind === 'tool');
    expect(tool?.isError).toBe(true);
    expect(tool?.text).toContain('✗');  });

  it('skips unknown records and increments indices sequentially', () => {
    const wirePath = withWire([
      { type: 'metadata', whatever: true },
      { type: 'turn.prompt', input: [{ type: 'text', text: 'a' }], time: T0 },
      { type: 'unknown.event', time: T0 + 100 },
      { type: 'turn.prompt', input: [{ type: 'text', text: 'b' }], time: T0 + 200 },
    ]);
    const cells = buildTraceCells({ wirePath });
    expect(cells.map((c) => c.index)).toEqual([1, 2]);
    expect(cells.map((c) => c.kind)).toEqual(['user', 'user']);
  });

  it('flushes trailing system-context changes at the end of the wire', () => {
    const wirePath = withWire([
      { type: 'turn.prompt', input: [{ type: 'text', text: 'hi' }], time: T0 },
      { type: 'config.update', systemPrompt: 'x', time: T0 + 100 },
      { type: 'tools.set_active_tools', names: ['bash', 'read'], time: T0 + 200 },
    ]);
    const cells = buildTraceCells({ wirePath });
    expect(cells.map((c) => c.kind)).toEqual(['user', 'system']);
    expect(cells[1]!.text).toContain('系统提示词已更新');
    expect(cells[1]!.text).toContain('bash, read');
    expect(cells[1]!.requestOnly).toBe(true);
  });

  it('keeps thinking separate from text when there are no block boundaries', () => {
    // v1.4-pre wires have no block.start/end; content.part must still split
    // think vs text by the part type.
    const wirePath = withWire([
      { type: 'turn.prompt', input: [{ type: 'text', text: 'q' }], time: T0 },
      loop('step.begin', { uuid: 's1', turnId: '0', step: 1 }, T0 + 100),
      loop('content.part', { part: { type: 'think', think: '先想' } }, T0 + 200),
      loop('content.part', { part: { type: 'text', text: '回复正文' } }, T0 + 300),
      loop('step.end', {}, T0 + 400),
    ]);
    const cells = buildTraceCells({ wirePath });
    const message = cells.find((c) => c.kind === 'message');
    expect(message?.thinkingDetail).toContain('先想');
    expect(message?.outputDetail).toContain('回复正文');
    expect(message?.thinkingDetail).not.toContain('回复正文');
  });
});
