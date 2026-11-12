import { describe, expect, it } from 'vitest';
import { visibleWidth } from '@liutod-scream/pi-tui';

import { WelcomeComponent } from '#/tui/components/chrome/welcome';

const ANSI = /\u001B\[[0-9;]*m/g;
const strip = (text: string): string => text.replaceAll(ANSI, '');

const state = {
  model: '',
  availableModels: {},
  version: '0.19.8',
  hasNewVersion: false,
  latestVersion: null,
  like: {},
};
const colors = {
  primary: '#79EB00',
  textDim: '#6b7280',
  warning: '#e0a030',
  success: '#79EB00',
};
const ui = { requestRender() {} };

function makeComponent(): WelcomeComponent {
  return new WelcomeComponent(state as never, colors as never, ui as never);
}

describe('WelcomeComponent render', () => {
  it('keeps every non-empty line exactly at the content width (no terminal overflow)', () => {
    // pi-tui aborts the TUI when a line is wider than the viewport, so exact
    // padding is a hard contract, not cosmetics.
    for (const width of [50, 54, 55, 80, 120]) {
      const component = makeComponent();
      const lines = component.render(width);
      component.stopBreathing();
      for (const line of lines) {
        if (line.length === 0) continue;
        expect(visibleWidth(line), `width ${width}: "${strip(line)}"`).toBe(Math.max(50, width));
      }
    }
  });

  it('drops the border and shows the mascot above the SCREAM wordmark', () => {
    const component = makeComponent();
    component.stopBreathing();
    const lines = component.render(120).map(strip);
    const text = lines.join('\n');

    for (const glyph of ['╭', '╮', '╰', '╯']) {
      expect(text).not.toContain(glyph);
    }
    // SCREAM-only art: the first art row is complete, the CODE half is gone.
    expect(lines.some((line) => line.includes('███████╗ ██████╗██████╗ ███████╗ █████╗ ███╗   ███╗'))).toBe(true);
    expect(text).not.toContain('██████╗ ██████╗ ██████╗ ███████╗');

    const mascotRow = lines.findIndex((line) => line.includes('██▄▄▄██'));
    const artRow = lines.findIndex((line) => line.includes('███████╗ ██████╗'));
    expect(mascotRow).toBeGreaterThanOrEqual(0);
    expect(artRow).toBeGreaterThan(mascotRow);
  });

  it('has no light rays once breathing stopped, and keeps width while animating', () => {
    const stopped = makeComponent();
    stopped.stopBreathing();
    const stoppedRows = stopped.render(120).slice(1, 3).map(strip);
    expect(stoppedRows.join('')).not.toMatch(/[▓▒░]/);

    // While the timer runs the pulses may add rays; the width contract holds
    // regardless of the phase the wall clock lands on.
    const breathing = makeComponent();
    const lines = breathing.render(120);
    breathing.stopBreathing();
    for (const line of lines) {
      if (line.length > 0) expect(visibleWidth(line)).toBe(120);
    }
  });
});
