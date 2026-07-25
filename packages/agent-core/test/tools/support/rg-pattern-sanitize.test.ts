import { describe, expect, it } from 'vitest';

import { isRegexSyntaxError, sanitizeRgPattern } from '../../../src/tools/support/rg-pattern-sanitize';

describe('sanitizeRgPattern', () => {
  it('preserves plain text without braces', () => {
    expect(sanitizeRgPattern('hello world')).toBe('hello world');
    expect(sanitizeRgPattern('fetchFoo(')).toBe('fetchFoo(');
  });

  it('preserves valid repetition quantifiers', () => {
    expect(sanitizeRgPattern('a{3}')).toBe('a{3}');
    expect(sanitizeRgPattern('a{2,}')).toBe('a{2,}');
    expect(sanitizeRgPattern('a{1,5}')).toBe('a{1,5}');
    expect(sanitizeRgPattern('\\d{3,4}')).toBe('\\d{3,4}');
  });

  it('escapes braces that do not form a valid quantifier', () => {
    expect(sanitizeRgPattern('${platform}')).toBe('$\\{platform\\}');
    expect(sanitizeRgPattern('foo{bar}')).toBe('foo\\{bar\\}');
    expect(sanitizeRgPattern('{missing')).toBe('\\{missing');
  });

  it('escapes standalone closing brace', () => {
    expect(sanitizeRgPattern('a}')).toBe('a\\}');
    expect(sanitizeRgPattern('}')).toBe('\\}');
  });

  it('preserves already-escaped braces', () => {
    expect(sanitizeRgPattern('\\{literal\\}')).toBe('\\{literal\\}');
    expect(sanitizeRgPattern('a\\{3\\}')).toBe('a\\{3\\}');
  });

  it('handles mixed valid and invalid braces', () => {
    expect(sanitizeRgPattern('a{3}${var}')).toBe('a{3}$\\{var\\}');
    expect(sanitizeRgPattern('{x}{2}')).toBe('\\{x\\}{2}');
  });

  it('preserves other regex metacharacters', () => {
    expect(sanitizeRgPattern('foo(bar)?')).toBe('foo(bar)?');
    expect(sanitizeRgPattern('[a-z]+')).toBe('[a-z]+');
    expect(sanitizeRgPattern('^test$')).toBe('^test$');
  });

  it('handles empty string', () => {
    expect(sanitizeRgPattern('')).toBe('');
  });

  it('escapes brace with non-numeric content', () => {
    expect(sanitizeRgPattern('{abc}')).toBe('\\{abc\\}');
    expect(sanitizeRgPattern('{1a}')).toBe('\\{1a\\}');
  });

  it('escapes brace with comma but no digits', () => {
    expect(sanitizeRgPattern('{,5}')).toBe('\\{,5\\}');
    expect(sanitizeRgPattern('{,}')).toBe('\\{,\\}');
  });
});

describe('isRegexSyntaxError', () => {
  it('detects regex parse error', () => {
    expect(isRegexSyntaxError('regex parse error: ...')).toBe(true);
  });

  it('detects unrecognized escape', () => {
    expect(isRegexSyntaxError('Error: unrecognized escape sequence')).toBe(true);
  });

  it('detects unclosed group', () => {
    expect(isRegexSyntaxError('regex parse error: unclosed group')).toBe(true);
  });

  it('detects unbalanced', () => {
    expect(isRegexSyntaxError('unbalanced parentheses')).toBe(true);
  });

  it('detects unexpected repetition', () => {
    expect(isRegexSyntaxError('unexpected repetition operator')).toBe(true);
  });

  it('returns false for filesystem errors', () => {
    expect(isRegexSyntaxError('No such file or directory')).toBe(false);
    expect(isRegexSyntaxError('Permission denied')).toBe(false);
  });

  it('returns false for empty stderr', () => {
    expect(isRegexSyntaxError('')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isRegexSyntaxError('REGEX PARSE ERROR')).toBe(true);
    expect(isRegexSyntaxError('Unclosed Group')).toBe(true);
  });
});
