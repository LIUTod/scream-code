/**
 * Every decorative animation answers to the one shared motion setting
 * (utils/motion): SCREAM_MOTION=off and its older name SCREAM_REDUCED_MOTION
 * stop them all, and SCREAM_SPINNER_INTERVAL_MS retunes (or, at 0, stops) the
 * spinners. Information that merely changes over time is not decoration — the
 * footer clocks have their own tests.
 */
import type { TUI } from '@liutod-scream/pi-tui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MoonLoader } from '#/tui/components/chrome/moon-loader';
import { PulseWaveLoader } from '#/tui/components/chrome/pulse-wave-loader';
import { ApprovalPanelComponent } from '#/tui/components/dialogs/approval-panel';
import { CompactionComponent } from '#/tui/components/dialogs/compaction';
import { QuestionDialogComponent } from '#/tui/components/dialogs/question-dialog';
import { ActivityGroupComponent } from '#/tui/components/messages/activity-group';
import { BackgroundAgentStatusComponent } from '#/tui/components/messages/background-agent-status';
import { ThinkingComponent } from '#/tui/components/messages/thinking';
import {
  BRAILLE_SPINNER_INTERVAL_MS,
  PULSE_WAVE_INTERVAL_MS,
} from '#/tui/constant/rendering';
import { STATUS_BULLET } from '#/tui/constant/symbols';
import { darkColors, getColorPalette } from '#/tui/theme/colors';
import { isReducedMotion } from '#/tui/utils/streaming-fade';
import { DEFAULT_SPINNER_INTERVAL_MS, applyMotionEnv, resetMotion } from '#/tui/utils/motion';

const ANSI = /\u001B\[[0-9;]*m/g;
const strip = (text: string): string => text.replaceAll(ANSI, '');

beforeEach(() => {
  vi.useFakeTimers();
  delete process.env['SCREAM_REDUCED_MOTION'];
});
afterEach(() => {
  resetMotion();
  vi.useRealTimers();
});

function fakeUi(): { ui: TUI; requestRender: ReturnType<typeof vi.fn> } {
  const requestRender = vi.fn();
  return { ui: { requestRender } as unknown as TUI, requestRender };
}

/** Each animated component, built with a live UI, plus how to tear it down. */
const COMPONENTS: Array<{
  name: string;
  /** Built inside the test so the motion setting is in force when it starts. */
  build: (ui: TUI) => { dispose: () => void };
}> = [
  {
    name: 'thinking block',
    build: (ui) => {
      const component = new ThinkingComponent('step', darkColors, true, 'live', ui);
      return { dispose: () => { component.finalize(); } };
    },
  },
  {
    name: 'activity group',
    build: (ui) => {
      const component = new ActivityGroupComponent(darkColors, ui);
      return { dispose: () => { component.dispose(); } };
    },
  },
  {
    name: 'background agent notice',
    build: (ui) => {
      const component = new BackgroundAgentStatusComponent(
        { phase: 'started', headline: 'bg task', detail: 'CI' },
        darkColors,
        ui,
      );
      return { dispose: () => { component.dispose(); } };
    },
  },
  {
    name: 'moon loader',
    build: (ui) => {
      const component = new MoonLoader(ui, undefined, 'loading');
      return { dispose: () => { component.dispose(); } };
    },
  },
  {
    name: 'status-bar pulse wave',
    build: (ui) => {
      const component = new PulseWaveLoader(ui, () => '#00ff00');
      return { dispose: () => { component.stop(); } };
    },
  },
];

describe('the default cadence is the one every spinner already used', () => {
  it('keeps the shared default equal to the per-component constants', () => {
    expect(DEFAULT_SPINNER_INTERVAL_MS).toBe(BRAILLE_SPINNER_INTERVAL_MS);
    expect(DEFAULT_SPINNER_INTERVAL_MS).toBe(PULSE_WAVE_INTERVAL_MS);
  });
});

describe.each(COMPONENTS)('$name', ({ build }) => {
  it('animates by default (a timer runs and repaints)', () => {
    const { ui, requestRender } = fakeUi();
    const component = build(ui);
    requestRender.mockClear();
    vi.advanceTimersByTime(BRAILLE_SPINNER_INTERVAL_MS * 3);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    expect(requestRender).toHaveBeenCalled();
    component.dispose();
  });

  for (const [label, env] of [
    ['SCREAM_MOTION=off', { SCREAM_MOTION: 'off' }],
    ['SCREAM_REDUCED_MOTION=1', { SCREAM_REDUCED_MOTION: '1' }],
    ['SCREAM_SPINNER_INTERVAL_MS=0', { SCREAM_SPINNER_INTERVAL_MS: '0' }],
  ] as const) {
    it(`runs no timer and repaints nothing under ${label}`, () => {
      applyMotionEnv(env);
      const { ui, requestRender } = fakeUi();
      const component = build(ui);
      requestRender.mockClear();
      vi.advanceTimersByTime(2000);
      expect(vi.getTimerCount()).toBe(0);
      expect(requestRender).not.toHaveBeenCalled();
      component.dispose();
    });
  }

  it('follows SCREAM_SPINNER_INTERVAL_MS instead of the built-in cadence', () => {
    applyMotionEnv({ SCREAM_SPINNER_INTERVAL_MS: '300' });
    const timeouts = vi.spyOn(globalThis, 'setTimeout');
    const { ui, requestRender } = fakeUi();
    const component = build(ui);
    requestRender.mockClear();
    vi.advanceTimersByTime(250); // well past the default 80 ms beat, short of 300
    expect(requestRender).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60);
    expect(requestRender).toHaveBeenCalled();
    // The re-armed tick waits out the new period too — not the old 80 ms beat,
    // which would wake the process four times as often for nothing.
    const delays = timeouts.mock.calls.map((call) => Number(call[1]));
    expect(delays.at(-1)).toBeGreaterThanOrEqual(250);
    component.dispose();
  });
});

describe('the spinner keeps its first frame when it does not run', () => {
  it('shows the same glyph before and after time passes under SCREAM_MOTION=off', () => {
    applyMotionEnv({ SCREAM_MOTION: 'off' });
    const { ui } = fakeUi();
    const component = new ThinkingComponent('step', darkColors, true, 'live', ui);
    const before = strip(component.render(80).join('\n'));
    vi.advanceTimersByTime(1000);
    expect(strip(component.render(80).join('\n'))).toBe(before);
    expect(before).toContain('⠋ 思考中...');
  });
});

describe('compaction blink', () => {
  it('blinks by default', () => {
    const { ui, requestRender } = fakeUi();
    const component = new CompactionComponent(darkColors, ui);
    vi.advanceTimersByTime(1100);
    expect(requestRender.mock.calls.length).toBeGreaterThanOrEqual(2);
    component.dispose();
  });

  it('stays lit, with no timer, when motion is off', () => {
    applyMotionEnv({ SCREAM_REDUCED_MOTION: 'yes' });
    const { ui, requestRender } = fakeUi();
    const component = new CompactionComponent(darkColors, ui);
    const first = strip(component.render(80).join('\n'));
    vi.advanceTimersByTime(3000);
    expect(vi.getTimerCount()).toBe(0);
    expect(requestRender).not.toHaveBeenCalled();
    expect(strip(component.render(80).join('\n'))).toBe(first);
    expect(first).toContain(STATUS_BULLET); // the bullet is visible, not caught mid-blink
    component.dispose();
  });
});

describe('dialog pulses', () => {
  function approval(ui: TUI): ApprovalPanelComponent {
    return new ApprovalPanelComponent(
      {
        data: {
          id: 'approval_1',
          tool_call_id: 'tool_1',
          tool_name: 'WriteFile',
          action: 'write a file',
          description: 'Update README.md',
          display: [],
          choices: [{ label: 'Approve once', response: 'approved' }],
        },
      },
      () => {},
      getColorPalette('dark'),
      undefined,
      undefined,
      undefined,
      ui,
    );
  }
  function question(ui: TUI): QuestionDialogComponent {
    return new QuestionDialogComponent(
      {
        data: {
          id: 'q_1',
          tool_call_id: 'tc_1',
          questions: [
            { question: 'Pick one?', multi_select: false, options: [{ label: 'A' }, { label: 'B' }] },
          ],
        },
      },
      () => {},
      darkColors,
      6,
      undefined,
      undefined,
      ui,
    );
  }

  it.each([
    ['approval panel', approval],
    ['question dialog', question],
  ] as const)('%s pulses by default and holds still when motion is off', (_name, make) => {
    const animated = fakeUi();
    const pulsing = make(animated.ui);
    vi.advanceTimersByTime(500);
    expect(animated.requestRender).toHaveBeenCalled();
    pulsing.stop();

    applyMotionEnv({ SCREAM_MOTION: 'off' });
    const still = fakeUi();
    const dialog = make(still.ui);
    vi.advanceTimersByTime(2000);
    expect(vi.getTimerCount()).toBe(0);
    expect(still.requestRender).not.toHaveBeenCalled();
    dialog.stop();
  });
});

describe('one switch, two names', () => {
  it('SCREAM_REDUCED_MOTION=1 at startup also reads as reduced motion for the stream fade', () => {
    expect(isReducedMotion()).toBe(false);
    applyMotionEnv({ SCREAM_REDUCED_MOTION: '1' });
    expect(isReducedMotion()).toBe(true);
  });

  it('SCREAM_MOTION=off also turns the stream fade off', () => {
    expect(isReducedMotion()).toBe(false);
    applyMotionEnv({ SCREAM_MOTION: 'off' });
    expect(isReducedMotion()).toBe(true);
  });

  it('the older variable still works live, without applyMotionEnv', () => {
    process.env['SCREAM_REDUCED_MOTION'] = '1';
    try {
      expect(isReducedMotion()).toBe(true);
    } finally {
      delete process.env['SCREAM_REDUCED_MOTION'];
    }
    expect(isReducedMotion()).toBe(false);
  });
});
