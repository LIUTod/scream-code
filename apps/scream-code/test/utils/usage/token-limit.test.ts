import { describe, expect, it } from 'vitest';

import { formatTokenLimit, parseTokenLimit } from '#/utils/usage/token-limit';

describe('parseTokenLimit', () => {
  it.each([
    ['50000000', 50_000_000],
    ['50_000_000', 50_000_000],
    ['50,000,000', 50_000_000],
    ['1 000 000', 1_000_000],
    ['5,000', 5_000],
    ['1,500k', 1_500_000],
    ['1,000.5m', 1_000_500_000],
    ['500k', 500_000],
    ['500K', 500_000],
    ['20m', 20_000_000],
    ['20M', 20_000_000],
    ['1.5m', 1_500_000],
    ['1.5b', 1_500_000_000],
    ['2b', 2_000_000_000],
    ['20 m', 20_000_000],
    ['20m tokens', 20_000_000],
    ['20mtoken', 20_000_000],
    ['500万', 5_000_000],
    ['1亿', 100_000_000],
    ['1.5亿', 150_000_000],
    ['  100m  ', 100_000_000],
  ])('reads %j as %d tokens', (input, tokens) => {
    expect(parseTokenLimit(input)).toEqual({ kind: 'limit', tokens });
  });

  it.each(['0', 'off', 'OFF', 'none', 'unlimited', 'disable', '关闭', '不限', '0k', '0m', '0.0m'])(
    'reads %j as "off"',
    (input) => {
      expect(parseTokenLimit(input)).toEqual({ kind: 'off' });
    },
  );

  it.each([
    '',
    '   ',
    'abc',
    'm',
    '-5m',
    '5x',
    '5mm',
    '1.5', // a decimal needs a unit; it is never silently rounded
    // Separators are strict thousands grouping — never a decimal comma, which would
    // turn an intended 1.5M into 15M without a word.
    '1,5m',
    '1,5',
    '1,00',
    ',5m',
    '1.5,0m',
    '1 5m',
    '50_00',
    '5_000_',
    '1__000',
    '50.000.000',
    '1.2.3m',
    '$5',
    '5 dollars',
    '99999999999999999999b', // beyond the safe integer range
  ])('rejects %j', (input) => {
    expect(parseTokenLimit(input)).toEqual({ kind: 'invalid' });
  });
});

describe('formatTokenLimit', () => {
  it.each([
    [0, '0'],
    [999, '999'],
    [1_000, '1k'],
    [500_000, '500k'],
    [1_000_000, '1M'],
    [1_250_000, '1.25M'],
    [100_000_000, '100M'],
    [1_000_000_000, '1B'],
    [2_500_000_000, '2.5B'],
    // Two decimals round up to 1000 of the unit: it is one of the next unit up.
    [999_994, '999.99k'],
    [999_995, '1M'],
    [999_999, '1M'],
    [999_999_999, '1B'],
    [1_999_999, '2M'],
  ])('shows %d as %s', (tokens, text) => {
    expect(formatTokenLimit(tokens)).toBe(text);
  });

  it('is safe on garbage input', () => {
    expect(formatTokenLimit(Number.NaN)).toBe('0');
    expect(formatTokenLimit(-1)).toBe('0');
  });

  it('round-trips what parseTokenLimit accepts', () => {
    for (const input of ['500k', '20m', '1.25m', '100m', '1b', '2.5b']) {
      const parsed = parseTokenLimit(input);
      expect(parsed.kind).toBe('limit');
      if (parsed.kind === 'limit') {
        expect(parseTokenLimit(formatTokenLimit(parsed.tokens))).toEqual(parsed);
      }
    }
  });
});
