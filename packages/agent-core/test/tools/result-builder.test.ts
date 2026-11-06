import { describe, expect, it } from 'vitest';

import {
  ToolResultBuilder,
  tailToBytes,
  truncateToBytes,
} from '../../src/tools/support/result-builder';

describe('ToolResultBuilder', () => {
  it('returns concatenated output and a confirmation message under the limit', async () => {
    const builder = new ToolResultBuilder({ maxBytes: 50 });

    expect(builder.write('Hello')).toBe(5);
    expect(builder.write(' world')).toBe(6);

    const result = await builder.ok('Operation completed');
    expect(result.output).toBe('Hello world');
    expect(result.message).toBe('Operation completed.');
    expect(builder.nChars).toBe(11);
  });

  it('truncates with marker at the cut point and appends the message after', async () => {
    const builder = new ToolResultBuilder({ maxBytes: 10 });

    expect(builder.write('Hello')).toBe(5);
    // The line no longer fits the head, so it moves to the tail whole instead
    // of being squeezed into a marker-only remnant: 7 bytes written.
    expect(builder.write(' world!')).toBe(7);
    expect(builder.nChars).toBeGreaterThanOrEqual(10);

    const result = await builder.ok('Operation completed');
    expect(result.output).toContain('Hello[...truncated]');
    expect(result.output).toContain('Output is truncated');
    expect(result.output.endsWith('Output is truncated to fit in the message.')).toBe(true);
    // The brief is folded into the output above; the side channel stays
    // empty so the UI does not render the same line twice.
    expect(result.message).toBeUndefined();
    expect(result.truncated).toBe(true);
  });

  it('truncates lines that exceed maxLineLength', async () => {
    const builder = new ToolResultBuilder({ maxBytes: 100, maxLineBytes: 20 });

    expect(builder.write('This is a very long line that should be truncated\n')).toBe(20);

    const result = await builder.ok();
    expect(result.output).toContain('[...truncated]');
    expect(result.output).toContain('Output is truncated');
    expect(result.message).toBeUndefined();
  });

  it('respects both per-line and per-buffer limits at once', async () => {
    const builder = new ToolResultBuilder({ maxBytes: 40, maxLineBytes: 20 });

    expect(builder.write('Line 1\n')).toBe(7);
    expect(builder.write('This is a very long line that exceeds limit\n')).toBe(20);
    // The head budget is full, so this line goes to the tail instead of being
    // squeezed into a marker-only remnant: it keeps its own per-line cap (20).
    expect(builder.write('This would exceed char limit')).toBe(20);
    expect(builder.write('ignored')).toBe(7);

    const result = await builder.ok();
    expect(result.output).toContain('[...truncated]');
    expect(result.output).toContain('Output is truncated');
    expect(result.message).toBeUndefined();
  });

  it('tracks nChars as the buffer grows', async () => {
    const builder = new ToolResultBuilder({ maxBytes: 20, maxLineBytes: 30 });

    expect(builder.nChars).toBe(0);

    builder.write('Short\n');
    expect(builder.nChars).toBe(6);

    builder.write('1\n2\n');
    expect(builder.nChars).toBe(10);

    builder.write('More text that exceeds');
    expect(builder.nChars).toBeGreaterThanOrEqual(20);
  });

  it('marks truncation when non-empty text arrives after the buffer is full', async () => {
    const builder = new ToolResultBuilder({ maxBytes: 5 });

    expect(builder.write('Hello')).toBe(5);
    expect(builder.write(' world')).toBe(6);

    const result = await builder.ok();
    expect(result.output).toContain('Hello');
    expect(result.output).toContain('[...truncated]');
    expect(result.output).toContain(' world');
    expect(result.output).toContain('Output is truncated');
    expect(result.truncated).toBe(true);
  });

  it('marks truncation when a multi-line write leaves unprocessed lines', async () => {
    const builder = new ToolResultBuilder({ maxBytes: 6 });

    expect(builder.write('Hello\nworld')).toBe(11);

    const result = await builder.ok();
    expect(result.output).toContain('Hello\n[...truncated]');
    expect(result.output).toContain('Output is truncated');
    expect(result.message).toBeUndefined();
  });

  it('keeps unterminated trailing text in output', async () => {
    const builder = new ToolResultBuilder({ maxBytes: 100 });

    expect(builder.write('Line 1\nLine 2\nLine 3')).toBe(20);

    const result = await builder.ok();
    expect(result.output).toBe('Line 1\nLine 2\nLine 3');
  });

  it('treats an empty write as a no-op', async () => {
    const builder = new ToolResultBuilder({ maxBytes: 50 });

    expect(builder.write('')).toBe(0);
    expect(builder.nChars).toBe(0);
  });

  it('returns the accumulated output with the supplied message and brief', async () => {
    const builder = new ToolResultBuilder({ maxBytes: 20 });

    builder.write('Some output');
    const result = await builder.error('Something went wrong', { brief: 'Error occurred' });

    expect(result.output).toContain('Some output');
    expect(result.output).toContain('Something went wrong');
    expect(result.message).toBeUndefined();
    expect(result.brief).toBe('Error occurred');
  });

  it('preserves an explicitly empty brief', async () => {
    const builder = new ToolResultBuilder({ maxBytes: 20 });

    const result = await builder.ok('Done', { brief: '' });

    expect(result.brief).toBe('');
  });

  it('preserves the truncation hint and brief together on error', async () => {
    const builder = new ToolResultBuilder({ maxBytes: 10 });

    builder.write('Very long output that exceeds limit');
    const result = await builder.error('Command failed', { brief: 'Failed' });

    expect(result.output).toContain('[...truncated]');
    expect(result.output).toContain('Command failed');
    expect(result.message).toBeUndefined();
    expect(result.brief).toBe('Failed');
  });

  it('returns executable output with critical messages included', async () => {
    const builder = new ToolResultBuilder({ maxBytes: 10 });

    builder.write('Very long output that exceeds limit');
    const result = await builder.ok('Operation completed');

    expect(result.output).toContain('[...truncated]');
    expect(result.output).toContain('Output is truncated');
    expect(result.message).toBeUndefined();
  });

  it('keeps normal success messages out of non-empty output', async () => {
    const builder = new ToolResultBuilder({ maxBytes: 100 });

    builder.write('ok\n');
    const result = await builder.ok('Command executed successfully.');

    expect(result.output).toBe('ok\n');
    expect(result.message).toBe('Command executed successfully.');
  });

  describe('head + tail truncation', () => {
    it('preserves head prefix and tail suffix when output exceeds maxChars', async () => {
      const builder = new ToolResultBuilder({ maxBytes: 20, maxTailBytes: 30 });
      builder.write('HEAD-START\n');
      builder.write('middle-fill-1\n');
      builder.write('middle-fill-2\n');
      builder.write('TAIL-END-LINE\n');

      const result = await builder.ok();
      expect(result.output).toContain('HEAD-START');
      expect(result.output).toContain('TAIL-END-LINE');
      expect(result.output).toContain('[...truncated]');
      expect(result.truncated).toBe(true);
    });

    it('keeps only the last maxTailChars chars in tail', async () => {
      const builder = new ToolResultBuilder({ maxBytes: 10, maxTailBytes: 15 });
      builder.write('0123456789head');
      builder.write('AAAABBBBCCCCDDDD');

      const result = await builder.ok();
      expect(result.output).toContain('AAABBBBCCCCDDDD');
      expect(result.output).not.toContain('AAAA');
    });

    it('handles a single chunk larger than maxTailChars', async () => {
      const builder = new ToolResultBuilder({ maxBytes: 5, maxTailBytes: 10 });
      builder.write('HEAD!');
      builder.write('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ');

      const result = await builder.ok();
      expect(result.output).toContain('QRSTUVWXYZ');
      expect(result.output).not.toContain('ABCDEFGHIJKLMNOP');
    });

    it('does not append tail separator when head is not full', async () => {
      const builder = new ToolResultBuilder({ maxBytes: 100 });
      builder.write('short output\n');
      const result = await builder.ok();
      expect(result.output).toBe('short output\n');
      expect(result.truncated).toBe(false);
    });

    it('returns total chars written (head + tail) from write()', async () => {
      const builder = new ToolResultBuilder({ maxBytes: 5, maxTailBytes: 100 });
      const headWritten = builder.write('Hello');
      const tailWritten = builder.write(' world');

      expect(headWritten).toBe(5);
      expect(tailWritten).toBe(6);
      expect(builder.nChars).toBe(11);
    });

    it('preserves tail content in toString() for command-not-found detection', async () => {
      const builder = new ToolResultBuilder({ maxBytes: 10, maxTailBytes: 100 });
      builder.write('progress line\n');
      builder.write('command not found: tsc\n');

      const text = builder.toString();
      expect(text).toContain('command not found');
    });

    it('drops all tail content when maxTailChars is 0', async () => {
      const builder = new ToolResultBuilder({ maxBytes: 5, maxTailBytes: 0 });
      builder.write('HEAD!');
      builder.write('this should be dropped');

      const result = await builder.ok();
      expect(result.output).toContain('HEAD!');
      expect(result.output).not.toContain('this should be dropped');
      expect(result.truncated).toBe(true);
    });

    it('reports the number of elided lines in the head/tail truncation marker', async () => {
      const builder = new ToolResultBuilder({ maxBytes: 6, maxTailBytes: 6, maxLineBytes: null });
      builder.write('L1\nL2\nL3\nL4\nL5\n');

      const result = await builder.ok();
      expect(result.output).toContain('[…1 lines elided…]');
      expect(result.output).toContain('L1');
      expect(result.output).toContain('L5');
      expect(result.output).not.toContain('L3');
      expect(result.truncated).toBe(true);
    });
  });
});

describe('byte budgets', () => {
  it('counts CJK by UTF-8 bytes, not characters', () => {
    // Each CJK character is 3 bytes: a 7-byte budget holds two of them.
    expect(truncateToBytes('中文中文', 7)).toBe('中文');
    expect(truncateToBytes('中文中文', 6)).toBe('中文');
    expect(truncateToBytes('abc', 8)).toBe('abc');
  });

  it('never splits a character, so no lone surrogate can reach the model', () => {
    const emoji = '😀😀😀';
    for (const budget of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) {
      const head = truncateToBytes(emoji, budget);
      const tail = tailToBytes(emoji, budget);
      for (const piece of [head, tail]) {
        for (const char of piece) {
          const code = char.codePointAt(0) ?? 0;
          expect(code === 0xfeff || code > 0xd7ff).toBe(true);
          expect(code < 0xd800 || code > 0xdfff).toBe(true);
        }
      }
    }
    expect(truncateToBytes(emoji, 4)).toBe('😀');
    expect(tailToBytes(emoji, 4)).toBe('😀');
  });

  it('keeps the head whole-line: a line that does not fit starts the tail', () => {
    const builder = new ToolResultBuilder({ maxBytes: 20 });
    builder.write('aaaaaaaaa\n');
    builder.write('bbbbbbbbb\n');
    builder.write('ccccccccc\n');

    const output = builder.toString();
    // No line is ever cut: every emitted line is one of the inputs or the marker.
    for (const line of output.split('\n').filter((entry) => entry.length > 0)) {
      expect(['aaaaaaaaa', 'bbbbbbbbb', 'ccccccccc', '[...truncated]']).toContain(line);
    }
    expect(output).toContain('ccccccccc');
  });

  it('stops the head at maxLines and moves the rest to the tail', () => {
    const builder = new ToolResultBuilder({ maxBytes: 10_000, maxLines: 2 });
    builder.write('one\ntwo\n');
    builder.write('three\n');

    const output = builder.toString();
    expect(output).toContain('one');
    expect(output).toContain('two');
    expect(output).toContain('three');
    expect(output).toContain('[...truncated]');
  });
});
