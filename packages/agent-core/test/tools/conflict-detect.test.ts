import { describe, expect, it } from 'vitest';

import {
  type ConflictBlock,
  formatConflictNotice,
  scanConflictLines,
} from '../../src/tools/builtin/file/conflict-detect';

describe('scanConflictLines', () => {
  it('returns empty when there are no conflict markers', () => {
    const lines = ['hello', 'world', 'foo = bar', '==something', '<< not a marker'];
    expect(scanConflictLines(lines)).toEqual<ConflictBlock[]>([]);
  });

  it('detects a complete three-section block with correct line numbers', () => {
    const lines = [
      'import foo',
      '<<<<<<< HEAD',
      'const a = 1;',
      '=======',
      'const a = 2;',
      '>>>>>>> branch',
      'export default a;',
    ];
    expect(scanConflictLines(lines)).toEqual<ConflictBlock[]>([
      { startLine: 2, separatorLine: 4, endLine: 6 },
    ]);
  });

  it('detects multiple complete blocks', () => {
    const lines = [
      '<<<<<<< HEAD',
      'a',
      '=======',
      'b',
      '>>>>>>> branch',
      'middle',
      '<<<<<<< HEAD',
      'c',
      '=======',
      'd',
      '>>>>>>> branch',
    ];
    expect(scanConflictLines(lines)).toEqual<ConflictBlock[]>([
      { startLine: 1, separatorLine: 3, endLine: 5 },
      { startLine: 7, separatorLine: 9, endLine: 11 },
    ]);
  });

  it('detects diff3 blocks with ||||||| base section', () => {
    const lines = [
      '<<<<<<< HEAD',
      'ours',
      '||||||| merged common ancestors',
      'base',
      '=======',
      'theirs',
      '>>>>>>> branch',
    ];
    expect(scanConflictLines(lines)).toEqual<ConflictBlock[]>([
      { startLine: 1, separatorLine: 5, endLine: 7, baseLine: 3 },
    ]);
  });

  it('returns empty when closer is missing (incomplete pair)', () => {
    const lines = ['<<<<<<< HEAD', 'const a = 1;', '=======', 'const a = 2;'];
    expect(scanConflictLines(lines)).toEqual<ConflictBlock[]>([]);
  });

  it('returns empty when separator is missing', () => {
    const lines = ['<<<<<<< HEAD', 'const a = 1;', 'const a = 2;', '>>>>>>> branch'];
    expect(scanConflictLines(lines)).toEqual<ConflictBlock[]>([]);
  });

  it('does not match markers indented past column 0', () => {
    const lines = [
      '  <<<<<<< HEAD',
      '  const a = 1;',
      '  =======',
      '  const a = 2;',
      '  >>>>>>> branch',
    ];
    expect(scanConflictLines(lines)).toEqual<ConflictBlock[]>([]);
  });

  it('does not match code lines that start with == or << but are not full markers', () => {
    const lines = ['== not a separator', '<< also not', 'foo == bar', 'x <<= 1'];
    expect(scanConflictLines(lines)).toEqual<ConflictBlock[]>([]);
  });

  it('matches marker with no label (prefix alone)', () => {
    const lines = ['<<<<<<<', 'a', '=======', 'b', '>>>>>>>'];
    expect(scanConflictLines(lines)).toEqual<ConflictBlock[]>([
      { startLine: 1, separatorLine: 3, endLine: 5 },
    ]);
  });

  it('rejects markers followed by non-space characters', () => {
    const lines = [
      '<<<<<<<HEAD',
      'a',
      '=======',
      'b',
      '>>>>>>>branch',
    ];
    expect(scanConflictLines(lines)).toEqual<ConflictBlock[]>([]);
  });

  it('uses firstLineNumber offset to report absolute line numbers', () => {
    const lines = ['<<<<<<< HEAD', 'a', '=======', 'b', '>>>>>>> branch'];
    expect(scanConflictLines(lines, 100)).toEqual<ConflictBlock[]>([
      { startLine: 100, separatorLine: 102, endLine: 104 },
    ]);
  });

  it('handles stray separator/closer without opener gracefully', () => {
    const lines = ['=======', 'b', '>>>>>>> branch', 'normal code'];
    expect(scanConflictLines(lines)).toEqual<ConflictBlock[]>([]);
  });

  it('handles stray opener-like line with extra chars', () => {
    const lines = ['<<<<<<< HEAD extra', 'a', '=======', 'b', '>>>>>>> branch'];
    expect(scanConflictLines(lines)).toEqual<ConflictBlock[]>([
      { startLine: 1, separatorLine: 3, endLine: 5 },
    ]);
  });

  it('strips trailing CR from CRLF lines before matching', () => {
    const lines = [
      '<<<<<<< HEAD\r',
      'a\r',
      '=======\r',
      'b\r',
      '>>>>>>> branch\r',
    ];
    expect(scanConflictLines(lines)).toEqual<ConflictBlock[]>([
      { startLine: 1, separatorLine: 3, endLine: 5 },
    ]);
  });
});

describe('formatConflictNotice', () => {
  it('returns empty string when no blocks', () => {
    expect(formatConflictNotice([])).toBe('');
  });

  it('formats a single block', () => {
    const blocks: ConflictBlock[] = [{ startLine: 2, separatorLine: 4, endLine: 6 }];
    expect(formatConflictNotice(blocks)).toBe(
      '⚠ 1 unresolved merge conflict(s) detected: lines 2-6',
    );
  });

  it('formats multiple blocks as comma-separated list', () => {
    const blocks: ConflictBlock[] = [
      { startLine: 1, separatorLine: 3, endLine: 5 },
      { startLine: 7, separatorLine: 9, endLine: 11 },
    ];
    expect(formatConflictNotice(blocks)).toBe(
      '⚠ 2 unresolved merge conflict(s) detected: lines 1-5, lines 7-11',
    );
  });
});
