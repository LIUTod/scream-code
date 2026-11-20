import { afterEach, describe, expect, it, vi } from 'vitest';
import { visibleWidth } from '@liutod-scream/pi-tui';

import { introFrame, WelcomeComponent } from '#/tui/components/chrome/welcome';
import { applyMotionEnv, resetMotion } from '#/tui/utils/motion';

const ANSI = /\u001B\[[0-9;]*m/g;
const strip = (text: string): string => text.replaceAll(ANSI, '');

const state = {
  model: '',
  availableModels: {},
  version: '0.20.0',
  hasNewVersion: false,
  latestVersion: null,
  like: {},
  recentSessions: [],
};
const colors = {
  primary: '#79EB00',
  textDim: '#6b7280',
  warning: '#e0a030',
  success: '#79EB00',
  text: '#E0E0E0',
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

describe('WelcomeComponent motion switch', () => {
  afterEach(() => {
    resetMotion();
    vi.useRealTimers();
  });

  it('does not breathe when motion is off: no timers, and the logo keeps its resting colour', () => {
    vi.useFakeTimers();
    applyMotionEnv({ SCREAM_MOTION: 'off' });
    const component = makeComponent();
    expect(vi.getTimerCount()).toBe(0);
    const still = component.render(120).slice(1, 3).map(strip).join('');
    expect(still).not.toMatch(/[▓▒░]/);
    component.stopBreathing();
  });
});

describe('WelcomeComponent intro', () => {
  it('wakes, shouts three times with the wordmark sweeping in, then settles at rest', () => {
    expect(introFrame(0)).toMatchObject({ face: '▐▄▄▀▄▄▌', reveal: 0, info: 0 });
    expect(introFrame(0).brightness).toBeLessThan(1);
    // Each shout looks somewhere, with the original faces only: centre, left, right.
    expect([520, 820, 1120].map((ms) => introFrame(ms).face)).toEqual(['▐▄▄▀▄▄▌', '▐▄▀▄▄▄▌', '▐▄▄▄▀▄▌']);
    const shout = introFrame(520);
    expect(shout.pulseTop).not.toBeNull();
    expect(shout.shift).not.toBe(0);
    expect(introFrame(1000).reveal).toBeGreaterThan(0);
    expect(introFrame(1000).reveal).toBeLessThan(1);
    expect(introFrame(2000).info).toBeGreaterThan(0);
    expect(introFrame(2400)).toMatchObject({ face: '▐█▄▀▄█▌', hueStep: null, reveal: 1, info: 1, shift: 0 });
  });

  it('keeps the width contract at every moment of the intro', () => {
    const widths = new Set<number>();
    for (let ms = 0; ms <= 2400; ms += 40) {
      const anim = makeComponent();
      (anim as unknown as { introStart: number }).introStart = Date.now() - ms;
      for (const line of anim.render(80)) if (line.length > 0) widths.add(visibleWidth(line));
      anim.stopBreathing();
    }
    expect([...widths]).toEqual([80]);
  });

  it('glances a bounded number of times after the intro, then rests', () => {
    vi.useFakeTimers();
    try {
      const component = makeComponent();
      vi.advanceTimersByTime(2500 + 6000 * 12);
      expect(vi.getTimerCount()).toBe(0);
      component.stopBreathing();
    } finally {
      vi.useRealTimers();
    }
  });

  it('says in one centred line what is worth picking up, and nothing when nothing is', () => {
    const hour = 3600_000;
    const render = (extra: Record<string, unknown>): string[] => {
      const component = new WelcomeComponent({ ...state, sessionId: 'now', memoryCount: 107, ...extra } as never, colors as never, ui as never);
      component.stopBreathing();
      return component.render(100);
    };
    const lines = render({
      recentSessions: [
        { id: 'now', title: 'current one', updatedAt: Date.now() },
        { id: 'old', title: 'Fix the resume title', updatedAt: Date.now() - 2 * hour },
      ],
      jobsWaiting: 1,
    });
    const status = lines.map(strip).filter((line) => line.includes('Fix the resume title'));
    expect(status).toHaveLength(1);
    const line = status[0]!;
    expect(line).not.toContain('current one');
    expect(line).toContain('107');
    expect(line.indexOf('Fix the resume title')).toBeLessThan(line.indexOf('107'));
    // Centred like the info line above it (±1).
    expect(Math.abs((line.length - line.trimStart().length) - (100 - visibleWidth(line.trimEnd())))).toBeLessThanOrEqual(1);
    for (const row of lines) if (row.length > 0) expect(visibleWidth(row)).toBe(100);

    // An old conversation is still the last one; the memory count shows on its own too.
    const old = render({ recentSessions: [{ id: 'old', title: 'hello', updatedAt: Date.now() - 19 * 24 * hour }] });
    expect(old.map(strip).join('\n')).toMatch(/hello.*107/);
    expect(render({ recentSessions: [] }).map(strip).join('\n')).toContain('107');
    // Nothing at all (a first start): no second line.
    const first = new WelcomeComponent({ ...state, sessionId: 'now', recentSessions: [] } as never, colors as never, ui as never);
    first.stopBreathing();
    expect(first.render(100).filter((line) => line.trim() !== '')).toHaveLength(lines.filter((line) => line.trim() !== '').length - 1);
  });

  it('shows the status line only once the intro has typed the info line, keeping its row', () => {
    const withData = { ...state, sessionId: 'now', recentSessions: [], memoryCount: 5, jobsWaiting: 1 };
    const early = new WelcomeComponent(withData as never, colors as never, ui as never);
    (early as unknown as { introStart: number }).introStart = Date.now() - 600;
    const during = early.render(100);
    early.stopBreathing();
    const after = early.render(100);
    const text = (rows: string[]): string => rows.map(strip).join('\n');
    expect(text(during)).not.toMatch(/ 5 /);
    expect(text(after)).toMatch(/5/);
    expect(during).toHaveLength(after.length);
  });

  it('offers Ctrl+R next to the last conversation exactly while the key would resume it', () => {
    const withData = { ...state, sessionId: 'now', memoryCount: 3, recentSessions: [{ id: 'old', title: 'Fix the title', updatedAt: Date.now() - 3600_000 }] };
    let available = true;
    const component = new WelcomeComponent(withData as never, colors as never, ui as never, { resumeAvailable: () => available });
    component.stopBreathing();
    expect(component.render(120).map(strip).join('\n')).toMatch(/Fix the title.*Ctrl\+R/);
    // Typed something, or a transcript replayed after a session switch: no key, no hint.
    available = false;
    expect(component.render(120).map(strip).join('\n')).not.toContain('Ctrl+R');
    // Without the predicate (another caller) the hint is never offered.
    const plain = new WelcomeComponent(withData as never, colors as never, ui as never);
    plain.stopBreathing();
    expect(plain.render(120).map(strip).join('\n')).not.toContain('Ctrl+R');
  });
});
