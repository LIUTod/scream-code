import { describe, expect, it } from 'vitest';
import chalk from 'chalk';

import { ErrorBannerComponent } from '#/tui/components/chrome/error-banner';
import { STATUS_BULLET } from '#/tui/constant/symbols';
import type { ColorPalette } from '#/tui/theme/colors';

const ANSI_SGR = /\[[0-9;]*m/g;

function fakeColors(): ColorPalette {
  return {
    primary: '#00ff00',
    textDim: '#888888',
    error: '#ff0000',
  } as unknown as ColorPalette;
}

function strip(s: string): string {
  return s.replaceAll(ANSI_SGR, '');
}

function hexToSgr(hex: string): string {
  const value = hex.replace(/^#/, '');
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return `[38;2;${r};${g};${b}m`;
}

describe('ErrorBannerComponent', () => {
  it('renders nothing when no message has been set', () => {
    const banner = new ErrorBannerComponent(fakeColors());
    expect(banner.render(80)).toEqual([]);
  });

  it('renders a leading blank, a bulleted first line, and indented continuations', () => {
    const banner = new ErrorBannerComponent(fakeColors());
    banner.setMessage('line one\nline two\nline three');
    const out = banner.render(80).map(strip);
    expect(out).toEqual([
      '',
      `${STATUS_BULLET}line one`,
      '  line two',
      '  line three',
    ]);
  });

  it('truncates to 3 lines and appends a dim "… (N more lines)" hint', () => {
    const banner = new ErrorBannerComponent(fakeColors());
    banner.setMessage('a\nb\nc\nd\ne\nf');
    const out = banner.render(80).map(strip);
    expect(out).toEqual([
      '',
      `${STATUS_BULLET}a`,
      '  b',
      '  c',
      '  … (3 more lines)',
    ]);
  });

  it('drops blank lines before truncating (delegates to truncateErrorMessage)', () => {
    const banner = new ErrorBannerComponent(fakeColors());
    banner.setMessage('real one\n\n\nreal two');
    const out = banner.render(80).map(strip);
    expect(out).toEqual([
      '',
      `${STATUS_BULLET}real one`,
      '  real two',
    ]);
  });

  it('clear() returns to empty render', () => {
    const banner = new ErrorBannerComponent(fakeColors());
    banner.setMessage('oops');
    expect(banner.render(80).length).toBeGreaterThan(0);
    banner.clear();
    expect(banner.render(80)).toEqual([]);
  });

  it('setMessage overwrites the previous message', () => {
    const banner = new ErrorBannerComponent(fakeColors());
    banner.setMessage('first error');
    banner.setMessage('second error');
    const out = banner.render(80).map(strip);
    expect(out).toEqual(['', `${STATUS_BULLET}second error`]);
  });

  it('uses the error color for the bulleted line and continuation lines', () => {
    const colors = fakeColors();
    const previousLevel = chalk.level;
    chalk.level = 3;
    try {
      const banner = new ErrorBannerComponent(colors);
      banner.setMessage('boom');
      const [, first] = banner.render(80);
      expect(first).toContain(hexToSgr(colors.error));
    } finally {
      chalk.level = previousLevel;
    }
  });

  it('renders the truncation hint in the dim color', () => {
    const colors = fakeColors();
    const previousLevel = chalk.level;
    chalk.level = 3;
    try {
      const banner = new ErrorBannerComponent(colors);
      banner.setMessage('a\nb\nc\nd');
      const lines = banner.render(80);
      const hintLine = lines.at(-1)!;
      expect(hintLine).toContain(hexToSgr(colors.textDim));
      expect(strip(hintLine)).toBe('  … (1 more lines)');
    } finally {
      chalk.level = previousLevel;
    }
  });

  it('hard-truncates lines that exceed the viewport width to prevent wrapping', () => {
    const banner = new ErrorBannerComponent(fakeColors());
    const long = 'x'.repeat(200);
    banner.setMessage(long);
    const out = banner.render(30).map(strip);
    expect(out.length).toBe(2);
    const firstLine = out[1]!;
    expect(firstLine.startsWith(STATUS_BULLET)).toBe(true);
    expect(firstLine.endsWith('...')).toBe(true);
    expect(firstLine.length).toBeLessThanOrEqual(32);
  });
});
