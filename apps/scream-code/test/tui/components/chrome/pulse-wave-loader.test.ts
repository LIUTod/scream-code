import chalk from 'chalk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PulseWaveLoader } from '#/tui/components/chrome/pulse-wave-loader';

/** Only `requestRender` is exercised by the loader. */
function fakeUi(): never {
  return { requestRender: vi.fn() } as never;
}

/** Strips SGR sequences so two frames can be compared by visible glyphs. */
function stripSgr(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

describe('PulseWaveLoader colour provider', () => {
  let originalLevel: typeof chalk.level;

  beforeEach(() => {
    originalLevel = chalk.level;
    chalk.level = 3; // non-TTY test env strips ANSI otherwise
  });

  afterEach(() => {
    chalk.level = originalLevel;
  });

  it('paints the wave with the colour resolved at paint time', () => {
    let color = '#00FF00';
    const loader = new PulseWaveLoader(fakeUi(), () => color);
    expect(loader.getFrameText()).toContain('38;2;0;255;0');

    // The provider is consulted on every repaint, so a theme switch or a ramp
    // step lands without rebuilding the status bar.
    loader.stop();
    color = '#FF0000';
    loader.start();
    expect(loader.getFrameText()).toContain('38;2;255;0;0');
    loader.stop();
  });

  it('repaints immediately when the palette is swapped in place', () => {
    let color = '#00FF00';
    const loader = new PulseWaveLoader(fakeUi(), () => color);
    color = '#FF0000';
    // No timer tick: a theme switch repaints the cached frame on the spot.
    loader.repaint();
    expect(loader.getFrameText()).toContain('38;2;255;0;0');
    loader.stop();
  });

  it('keeps the wave width-stable across colour changes', () => {
    let color = '#00FF00';
    const loader = new PulseWaveLoader(fakeUi(), () => color);
    const before = loader.getFrameText();
    loader.stop();
    color = '#E85454';
    loader.start();
    const after = loader.getFrameText();
    loader.stop();
    // Colour is the only difference: the visible glyph run never reflows.
    expect(after).toContain('■');
    expect(stripSgr(before)).toBe(stripSgr(after));
  });
});
