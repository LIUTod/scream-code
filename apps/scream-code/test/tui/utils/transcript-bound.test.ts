import { describe, expect, it } from 'vitest';

import {
  UI_OUTPUT_MAX_CHARS,
  UI_OUTPUT_MAX_HEAD_LINES,
  UI_OUTPUT_MAX_TAIL_LINES,
  boundEntryForUi,
} from '#/tui/utils/transcript-bound';
import type { TranscriptEntry, ToolCallBlockData, ToolResultBlockData } from '#/tui/types';

function toolEntry(
  output: string,
  resultExtra: Partial<ToolResultBlockData> = {},
  dataExtra: Partial<ToolCallBlockData> = {},
): TranscriptEntry {
  return {
    id: 'e-1',
    kind: 'tool_call',
    renderMode: 'plain',
    content: '',
    toolCallData: {
      id: 'tc-1',
      name: 'Bash',
      args: { command: 'run' },
      result: { tool_call_id: 'tc-1', output, is_error: false, ...resultExtra },
      ...dataExtra,
    },
  };
}

function boundedOutput(entry: TranscriptEntry): string {
  const output = boundEntryForUi(entry).toolCallData?.result?.output;
  expect(typeof output).toBe('string');
  return output ?? '';
}

describe('boundEntryForUi', () => {
  it('bounds a 10MB tool output to the head+tail window (≤ 8KB + marker)', () => {
    const line = 'x'.repeat(100);
    const output = Array.from({ length: 100_000 }, () => line).join('\n'); // ~10MB
    expect(output.length).toBeGreaterThan(10_000_000);

    const bounded = boundedOutput(toolEntry(output));

    const marker = /…(\d+) lines elided…/.exec(bounded);
    expect(marker).not.toBeNull();
    expect(bounded.length).toBeLessThanOrEqual(UI_OUTPUT_MAX_CHARS + marker![0]!.length);
  });

  it('reports the exact number of elided middle lines', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line-${String(i)}`);

    const bounded = boundedOutput(toolEntry(lines.join('\n')));

    expect(bounded).toContain(`…${String(200 - UI_OUTPUT_MAX_HEAD_LINES - UI_OUTPUT_MAX_TAIL_LINES)} lines elided…`);
    expect(bounded).toContain('line-0');
    expect(bounded).toContain('line-39');
    expect(bounded).toContain('line-160');
    expect(bounded).toContain('line-199');
    expect(bounded).not.toContain('line-100');
  });

  it('elides by line count even when the char budget is not the binding constraint', () => {
    const lines = Array.from({ length: 120 }, (_, i) => `row-${String(i)}`);

    const bounded = boundedOutput(toolEntry(lines.join('\n')));

    expect(bounded).toContain('…40 lines elided…');
    expect(bounded).toContain('row-0');
    expect(bounded).toContain('row-119');
    expect(bounded).not.toContain('row-60');
  });

  it('slices a lone oversized line within the char budget', () => {
    const output = 'y'.repeat(50_000);

    const bounded = boundedOutput(toolEntry(output));

    expect(bounded.length).toBeLessThanOrEqual(UI_OUTPUT_MAX_CHARS + '[...truncated]'.length);
    expect(bounded.startsWith('y')).toBe(true);
  });

  it('returns non-tool entries as-is (same reference)', () => {
    const user: TranscriptEntry = {
      id: 'e-user',
      kind: 'user',
      renderMode: 'plain',
      content: 'z'.repeat(20_000),
    };
    const status: TranscriptEntry = {
      id: 'e-status',
      kind: 'status',
      renderMode: 'plain',
      content: 'w'.repeat(20_000),
    };
    expect(boundEntryForUi(user)).toBe(user);
    expect(boundEntryForUi(status)).toBe(status);
  });

  it('returns a tool entry as-is when its output already fits', () => {
    const entry = toolEntry('small output');
    expect(boundEntryForUi(entry)).toBe(entry);
  });

  it('keeps message, args and titles untouched and never mutates the original entry', () => {
    const lines = Array.from({ length: 300 }, (_, i) => `data-${String(i)}`);
    const output = lines.join('\n');
    const entry = toolEntry(
      output,
      { message: 'side channel', display: { kind: 'search_results' } as never },
      { name: 'Grep', description: 'title', args: { pattern: 'p' } },
    );

    const bounded = boundEntryForUi(entry);

    expect(bounded).not.toBe(entry);
    const data = bounded.toolCallData!;
    expect(data.name).toBe('Grep');
    expect(data.description).toBe('title');
    expect(data.args).toEqual({ pattern: 'p' });
    expect(data.result!.message).toBe('side channel');
    expect(data.result!.display).toEqual({ kind: 'search_results' });
    expect(data.result!.is_error).toBe(false);
    // Source entry is left alone — only the stored copy is bounded.
    expect(entry.toolCallData!.result!.output).toBe(output);
  });
});
