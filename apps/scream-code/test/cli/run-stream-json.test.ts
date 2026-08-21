import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildStreamJsonRuntimePrompt,
  ClaudeStreamJsonWriter,
  extractUserText,
  installStdoutEpipeGuard,
  mapCcConnectMode,
} from '../../src/cli/run-stream-json';

describe('stream-json runtime system prompt', () => {
  it('keeps the default profile when only append prompts are supplied', () => {
    const prompt = buildStreamJsonRuntimePrompt({
      appendSystemPrompt: 'inline instructions',
      appendSystemPromptFileContent: 'file instructions',
    });

    expect(prompt.replace).toBeUndefined();
    expect(prompt.append).toContain('cc-connect send --image');
    expect(prompt.append).toContain('cc-connect send --file');
    expect(prompt.append.indexOf('inline instructions')).toBeLessThan(
      prompt.append.indexOf('file instructions'),
    );
  });

  it('normalizes a replacement prompt and appends delivery instructions after it', () => {
    const prompt = buildStreamJsonRuntimePrompt({
      systemPrompt: '  replacement prompt  ',
      appendSystemPrompt: '  extra instructions  ',
    });

    expect(prompt.replace).toBe('replacement prompt');
    expect(prompt.append).toMatch(/^【重要】/);
    expect(prompt.append).toContain('\n\nextra instructions');
  });

  it('ignores empty optional prompt parts without changing the stable send hint', () => {
    const prompt = buildStreamJsonRuntimePrompt({
      systemPrompt: '   ',
      appendSystemPrompt: '',
      appendSystemPromptFileContent: '  ',
    });

    expect(prompt.replace).toBeUndefined();
    expect(prompt.append).toContain('cc-connect send --image');
    expect(prompt.append).not.toContain('\n\n\n');
  });
});

function makeWriter() {
  const lines: unknown[] = [];
  const writer = new ClaudeStreamJsonWriter((line: string) => {
    lines.push(JSON.parse(line));
  });
  return { writer, lines };
}

interface Event {
  type: string;
  message?: { content: Array<Record<string, any>> };
  usage?: { input_tokens: number; output_tokens: number };
  [key: string]: unknown;
}

describe('mapCcConnectMode', () => {
  it.each([
    ['default', 'manual', false],
    ['acceptEdits', 'manual', false],
    ['dontAsk', 'manual', false],
    ['plan', 'manual', true],
    ['auto', 'auto', false],
    ['bypassPermissions', 'yolo', false],
    ['yolo', 'yolo', false],
  ] as const)('maps %s → permission=%s planMode=%s', (input, permission, planMode) => {
    expect(mapCcConnectMode(input)).toEqual({ permission, planMode });
  });

  it('falls back to auto when no mode is configured', () => {
    expect(mapCcConnectMode(undefined)).toEqual({ permission: 'auto', planMode: false });
  });
});

describe('extractUserText', () => {
  it('returns a string content as-is', () => {
    expect(extractUserText({ type: 'user', message: { role: 'user', content: 'hello' } })).toBe('hello');
  });

  it('joins text blocks from a content array with newlines', () => {
    expect(
      extractUserText({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'a' },
            { type: 'image' },
            { type: 'text', text: 'b' },
          ],
        },
      }),
    ).toBe('a\nb');
  });

  it('returns empty string when no text blocks are present', () => {
    expect(
      extractUserText({ type: 'user', message: { role: 'user', content: [{ type: 'image' }] } }),
    ).toBe('');
  });
});

describe('ClaudeStreamJsonWriter', () => {
  it('emits a system init line, with the model only when supplied', () => {
    const { writer, lines } = makeWriter();
    writer.emitSystem('s1', 'm');
    expect(lines[0]).toMatchObject({ type: 'system', subtype: 'init', session_id: 's1', model: 'm' });

    writer.emitSystem('s2');
    expect(lines[1]).toEqual({ type: 'system', subtype: 'init', session_id: 's2' });
  });

  it('emits buffered assistant text as one event on flush', () => {
    const { writer, lines } = makeWriter();
    writer.writeAssistantDelta('hello ');
    writer.writeAssistantDelta('world');
    expect(lines).toHaveLength(0);
    writer.flushAssistant();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello world' }] },
    });
  });

  it('emits thinking before the buffered text it precedes', () => {
    const { writer, lines } = makeWriter();
    writer.writeAssistantDelta('visible text');
    writer.writeThinkingDelta('private reasoning');
    writer.flushAssistant();
    expect(lines).toHaveLength(2);
    expect(lines[0] as Event).toMatchObject({
      type: 'assistant',
      message: { content: [{ type: 'thinking', thinking: 'private reasoning' }] },
    });
    expect(lines[1] as Event).toMatchObject({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'visible text' }] },
    });
  });

  it('merges streamed tool-argument parts into the pending tool call', () => {
    const { writer, lines } = makeWriter();
    writer.writeToolCallDelta('t1', 'Bash', '{"cmd":"ls');
    writer.writeToolCallDelta('t1', 'Bash', '"}');
    writer.flushAssistant();
    const content = (lines.at(-1) as Event).message!.content;
    expect(content[0]).toMatchObject({ type: 'tool_use', id: 't1', name: 'Bash', input: '{"cmd":"ls"}' });
  });

  it('bundles pending text and tool calls into a single assistant event', () => {
    const { writer, lines } = makeWriter();
    writer.writeAssistantDelta('running');
    writer.writeToolCall('t2', 'Read', { path: 'a.ts' });
    writer.flushAssistant();
    expect(lines).toHaveLength(1);
    const content = (lines[0] as Event).message!.content;
    expect(content[0]).toMatchObject({ type: 'text', text: 'running' });
    expect(content[1]).toMatchObject({ type: 'tool_use', id: 't2', name: 'Read', input: { path: 'a.ts' } });
  });

  it('emits a tool result as a user event', () => {
    const { writer, lines } = makeWriter();
    writer.writeToolResult('t2', 'all good', false);
    expect(lines[0]).toMatchObject({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 't2', content: 'all good', is_error: false }],
      },
    });
  });

  it('emits no assistant event when there is nothing to flush', () => {
    const { writer, lines } = makeWriter();
    writer.flushAssistant();
    expect(lines).toHaveLength(0);
  });

  it('discardAssistant clears pending text and tool calls', () => {
    const { writer, lines } = makeWriter();
    writer.writeAssistantDelta('will be dropped');
    writer.writeToolCallDelta('t9', 'Grep', '{}');
    writer.discardAssistant();
    writer.flushAssistant();
    expect(lines).toHaveLength(0);
  });

  it('carries accumulated token usage on the result event when non-zero', () => {
    const { writer, lines } = makeWriter();
    writer.updateUsage(1, 2);
    writer.emitResult('success', 'done', writer.getTokenUsage());
    const result = lines.find((l) => (l as Event).type === 'result') as Event;
    expect(result).toMatchObject({ type: 'result', subtype: 'success', result: 'done', session_id: '' });
    expect(result.usage).toEqual({ input_tokens: 1, output_tokens: 2 });
  });

  it('omits usage from the result event when it is never set', () => {
    const { writer, lines } = makeWriter();
    writer.emitResult('success', 'done');
    const result = lines.find((l) => (l as Event).type === 'result') as Event;
    expect(result).not.toHaveProperty('usage');
  });

  it('getTokenUsage accumulates and resets to zero after emitResult', () => {
    const { writer } = makeWriter();
    writer.updateUsage(7, 3);
    expect(writer.getTokenUsage()).toEqual({ input: 7, output: 3 });
    writer.emitResult('success', 'done', writer.getTokenUsage());
    expect(writer.getTokenUsage()).toEqual({ input: 0, output: 0 });
  });

  it('emits a resume-hint meta message', () => {
    const { writer, lines } = makeWriter();
    writer.emitResumeHint('s1');
    expect(lines[0]).toMatchObject({
      role: 'meta',
      type: 'session.resume_hint',
      session_id: 's1',
      command: 'scream -r s1',
      content: 'Resume this session: scream -r s1',
    });
  });

  it('emits a control_request event for the permission flow', () => {
    const { writer, lines } = makeWriter();
    writer.emitControlRequest('r1', 'tc1', 'Bash', { cmd: 'ls' });
    expect(lines[0]).toMatchObject({
      type: 'control_request',
      request_id: 'r1',
      request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { cmd: 'ls' } },
    });
  });
});

describe('installStdoutEpipeGuard', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Mock exit to throw so the call is observable without killing the test process.
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__exit_${code}`);
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exits cleanly when stdout.write throws EPIPE', () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => {
      const e: NodeJS.ErrnoException = new Error('write failed');
      e.code = 'EPIPE';
      throw e;
    });
    const writeLine = installStdoutEpipeGuard();
    expect(() => writeLine('hello')).toThrow('__exit_0');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('rethrows non-EPIPE write errors without exiting', () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => {
      const e: NodeJS.ErrnoException = new Error('write failed');
      e.code = 'EACCES';
      throw e;
    });
    const writeLine = installStdoutEpipeGuard();
    expect(() => writeLine('hello')).toThrow('write failed');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('exits cleanly on an EPIPE error event on stdout', () => {
    installStdoutEpipeGuard();
    const e: NodeJS.ErrnoException = new Error('EPIPE');
    e.code = 'EPIPE';
    expect(() => process.stdout.emit('error', e)).toThrow('__exit_0');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('does not exit on a non-EPIPE error event', () => {
    installStdoutEpipeGuard();
    const e: NodeJS.ErrnoException = new Error('reset');
    e.code = 'ECONNRESET';
    process.stdout.emit('error', e);
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
