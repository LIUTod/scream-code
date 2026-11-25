import { visibleWidth } from '@liutod-scream/pi-tui';
import chalk from 'chalk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const prefs = vi.hoisted(() => ({ banded: true }));
vi.mock('#/tui/utils/ui-preferences', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#/tui/utils/ui-preferences')>();
  return { ...actual, isUserMessageHighlightEnabled: () => prefs.banded };
});

import { UserMessageComponent } from '#/tui/components/messages/user-message';
import { darkColors, lightColors, type ColorPalette } from '#/tui/theme/colors';

function stripAnsi(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}
const bg = (hex: string): string => {
  const [r, g, b] = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
  return `\u001B[48;2;${String(r)};${String(g)};${String(b)}m`;
};
const fg = (hex: string): string => {
  const [r, g, b] = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
  return `\u001B[38;2;${String(r)};${String(g)};${String(b)}m`;
};

describe('UserMessageComponent', () => {
  let level: typeof chalk.level;
  beforeEach(() => {
    level = chalk.level;
    chalk.level = 3;
    prefs.banded = true;
  });
  afterEach(() => {
    chalk.level = level;
  });

  it('renders video placeholders as plain text, not inline image escapes', () => {
    const component = new UserMessageComponent('please inspect [video #1 sample.mov]', darkColors, []);

    const out = stripAnsi(component.render(80).join('\n'));

    expect(out).toContain('[video #1 sample.mov]');
  });

  it('puts the message on a soft full-width band only as tall as its text, in the user colour', () => {
    const rows = new UserMessageComponent('first line\nsecond line', darkColors).render(60);

    // One spacer row above, then exactly the two text rows: no padding rows.
    expect(rows).toHaveLength(3);
    expect(stripAnsi(rows[0]!).trim()).toBe('');
    for (const row of rows.slice(1)) {
      expect(row.startsWith(bg(darkColors.userMessageBg))).toBe(true);
      expect(row.endsWith('\u001B[49m')).toBe(true);
      expect(visibleWidth(row)).toBe(60);
    }
    expect(stripAnsi(rows[1]!)).toMatch(/^■ first line +$/);
    expect(stripAnsi(rows[2]!)).toMatch(/^ {2}second line +$/);
    // The mark and the text keep the user colour, bold; only the background changed.
    expect(rows[1]).toContain(fg(darkColors.roleUser));
    expect(rows[1]).not.toContain(fg(darkColors.text));
    expect(rows[1]).toContain('\u001B[1m');
    expect(rows[1]).not.toContain(bg('#f7e308'));
  });

  it('keeps the plain look with /hl off and below 256 colours', () => {
    prefs.banded = false;
    const off = new UserMessageComponent('hello', darkColors).render(40);
    expect(off.join('')).not.toContain('\u001B[48;');
    expect(stripAnsi(off[1]!)).toMatch(/^■ hello/);

    prefs.banded = true;
    chalk.level = 1;
    const basic = new UserMessageComponent('hello', darkColors).render(40);
    expect(basic.join('')).not.toMatch(/\u001B\[4[0-9;]*m|\u001B\[48;/);
  });

  it('never bands a system reminder', () => {
    const rows = new UserMessageComponent('<system-reminder>x</system-reminder>', darkColors).render(40);
    expect(rows.join('')).not.toContain('\u001B[48;');
  });

  it('follows a theme change made in place, without being rebuilt', () => {
    const colors: ColorPalette = { ...darkColors };
    const component = new UserMessageComponent('hello', colors);
    const dark = component.render(40)[1]!;
    expect(dark).toContain(bg(darkColors.userMessageBg));
    expect(dark).toContain(fg(darkColors.roleUser));

    Object.assign(colors, lightColors);
    const light = component.render(40)[1]!;
    expect(light).toContain(bg(lightColors.userMessageBg));
    expect(light).toContain(fg(lightColors.roleUser));
  });

  it('shows the head and tail of a very long message with the rows between counted', () => {
    const text = Array.from({ length: 60 }, (_, i) => `log line ${String(i)}`).join('\n');
    const rows = new UserMessageComponent(text, darkColors).render(60).map(stripAnsi);

    expect(rows).toHaveLength(1 + 12 + 1 + 4);
    expect(rows[1]).toContain('log line 0');
    expect(rows[12]).toContain('log line 11');
    expect(rows[13]).toMatch(/44/);
    expect(rows.at(-1)).toContain('log line 59');
  });

  it('caches render output for the same width and returns the same array reference', () => {
    const component = new UserMessageComponent('cached message', darkColors);

    const first = component.render(80);
    const second = component.render(80);

    expect(second).toBe(first);
  });

  it('recomputes after invalidate() is called', () => {
    const component = new UserMessageComponent('cached message', darkColors);

    const first = component.render(80);
    component.invalidate();
    const second = component.render(80);

    expect(second).not.toBe(first);
    expect(second).toEqual(first);
  });

  it('recomputes when width changes', () => {
    const component = new UserMessageComponent('cached message', darkColors);

    const narrow = component.render(40);
    const wide = component.render(80);

    expect(wide).not.toBe(narrow);
  });
});
