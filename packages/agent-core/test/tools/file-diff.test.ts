import { describe, expect, it } from 'vitest';

import { countLines, fileDiffSummary, fileDiffDetails, FILE_DIFF_PREVIEW_ROWS } from '../../src/tools/support/file-diff';

describe('countLines', () => {
  it('counts the empty string as zero lines', () => {
    expect(countLines('')).toBe(0);
  });

  it('counts a single line without a trailing newline as one line', () => {
    expect(countLines('a')).toBe(1);
  });

  it('counts a single line with a trailing newline as one line', () => {
    expect(countLines('a\n')).toBe(1);
  });

  it('counts interior lines without inflating on the trailing newline', () => {
    expect(countLines('a\nb\nc')).toBe(3);
    expect(countLines('a\nb\nc\n')).toBe(3);
  });

  it('counts a blank line as a line', () => {
    expect(countLines('\n')).toBe(1);
    expect(countLines('a\n\nb\n')).toBe(3);
  });

  it('counts CRLF-terminated lines once each', () => {
    expect(countLines('a\r\nb\r\n')).toBe(2);
    expect(countLines('a\r\nb')).toBe(2);
  });
});

describe('fileDiffSummary', () => {
  it('reports pure additions', () => {
    expect(fileDiffSummary('a\n', 'a\nb\nc\n')).toEqual({ added: 2, removed: 0 });
  });

  it('reports pure removals', () => {
    expect(fileDiffSummary('a\nb\nc\n', 'a\n')).toEqual({ added: 0, removed: 2 });
  });

  it('reports a rewritten line as one addition plus one removal', () => {
    expect(fileDiffSummary('a\nb\nc\n', 'a\nB\nc\n')).toEqual({ added: 1, removed: 1 });
  });

  it('reports an empty to non-empty transition as all additions', () => {
    expect(fileDiffSummary('', 'x\ny\n')).toEqual({ added: 2, removed: 0 });
  });

  it('reports a non-empty to empty transition as all removals', () => {
    expect(fileDiffSummary('x\ny\n', '')).toEqual({ added: 0, removed: 2 });
  });

  it('reports a no-op diff as zero lines on both sides', () => {
    expect(fileDiffSummary('a\nb\n', 'a\nb\n')).toEqual({ added: 0, removed: 0 });
    expect(fileDiffSummary('', '')).toEqual({ added: 0, removed: 0 });
  });

  it('treats the missing trailing newline as part of the last line', () => {
    // The final line is a changed line here, not a new one: one removal (the
    // old line) plus one addition (the same text, now terminated).
    expect(fileDiffSummary('a\nb', 'a\nb\n')).toEqual({ added: 1, removed: 1 });
  });

  it('counts CRLF content the same way as LF content', () => {
    expect(fileDiffSummary('a\r\nb\r\nc\r\n', 'a\r\nB\r\nc\r\n')).toEqual({
      added: 1,
      removed: 1,
    });
    expect(fileDiffSummary('a\nb\nc\n', 'a\nB\nc\n')).toEqual({ added: 1, removed: 1 });
  });

  it('counts whitespace-only changes as real changes', () => {
    expect(fileDiffSummary('a\n', '  a\n')).toEqual({ added: 1, removed: 1 });
  });

  it('returns undefined when either side exceeds the size guard', () => {
    const oversized = 'x'.repeat(1_000_001);
    expect(fileDiffSummary(oversized, 'a\n')).toBeUndefined();
    expect(fileDiffSummary('a\n', oversized)).toBeUndefined();
    expect(fileDiffSummary(oversized, oversized)).toBeUndefined();
  });

  it('still diffs input of exactly the size guard', () => {
    const atLimit = `${'x'.repeat(999_999)}\n`;
    expect(atLimit.length).toBe(1_000_000);
    expect(fileDiffSummary(atLimit, 'a\n')).toEqual({ added: 1, removed: 1 });
  });

  it('gives up on an adversarial diff instead of stalling the caller', () => {
    // Two same-sized blobs with no lines in common: this shape stays
    // quadratic-ish inside the size guard (minutes before aborting), so the
    // wall-clock budget must return "unknown" instead of blocking the tool.
    const before = Array.from({ length: 24_000 }, (_, i) => `{"k${String(i)}":${String(i)}}`).join('\n');
    const after = Array.from({ length: 24_000 }, (_, i) => `{"x${String(i)}":${String(i * 7)}}`).join('\n');

    const started = Date.now();
    expect(fileDiffSummary(before, after)).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('fileDiffDetails', () => {
  it('numbers changed lines in the file and keeps only the first rows of a large change', () => {
    const before = Array.from({ length: 30 }, (_, i) => `line ${String(i + 1)}`).join('\n') + '\n';
    const after = before.replace('line 5\n', 'line five\n') + Array.from({ length: 20 }, (_, i) => `extra ${String(i)}`).join('\n') + '\n';
    const details = fileDiffDetails(before, after, { deletedText: true });
    expect(details?.preview[0]).toEqual({ kind: 'delete', line: 5, text: 'line 5' });
    expect(details?.preview[1]).toEqual({ kind: 'add', line: 5, text: 'line five' });
    expect(details?.preview[2]).toEqual({ kind: 'add', line: 31, text: 'extra 0' });
    expect(details?.preview).toHaveLength(FILE_DIFF_PREVIEW_ROWS);
    expect(details?.previewTotal).toBe(22);
    expect(details?.added).toBe(21);
    expect(details?.removed).toBe(1);
  });

  it('drops deleted text unless the call carried it', () => {
    expect(fileDiffDetails('a\nb\n', 'a\nc\n', { deletedText: false })?.preview).toEqual([
      { kind: 'delete', line: 2, text: undefined },
      { kind: 'add', line: 2, text: 'c' },
    ]);
  });
});
