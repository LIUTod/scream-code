import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TUI } from '@liutod-scream/pi-tui';

import { FooterComponent } from '#/tui/components/chrome/footer';
import { darkColors } from '#/tui/theme/colors';
import type { AppState } from '#/tui/types';

function baseState(overrides: Partial<AppState> = {}): AppState {
  return {
    model: 'scream-s3',
    workDir: '/tmp',
    sessionId: 'sess_1',
    permissionMode: 'manual',
    planMode: 'off',
    thinkingLevel: 'off',
    contextUsage: 0,
    contextTokens: 0,
    maxContextTokens: 0,
    isCompacting: false,
    isReplaying: false,
    streamingPhase: 'idle',
    streamingStartTime: 0,
    theme: 'dark',
    version: 'test',
    editorCommand: null,
    notifications: { enabled: true, condition: 'unfocused' },
    availableModels: {},
    ...overrides,
  } as AppState;
}

describe('FooterComponent - active status animation', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeFooter(state: AppState) {
    const requestRender = vi.fn();
    const ui = { requestRender } as unknown as TUI;
    const footer = new FooterComponent(state, darkColors, ui);
    return { footer, requestRender };
  }

  it('stays quiet while idle and ticks independently in every active phase', () => {
    vi.useFakeTimers();
    const { footer, requestRender } = makeFooter(baseState());

    vi.advanceTimersByTime(500);
    expect(requestRender).not.toHaveBeenCalled();

    for (const phase of ['waiting', 'tool', 'composing'] as const) {
      footer.setState(baseState({ streamingPhase: phase }));
      requestRender.mockClear();
      vi.advanceTimersByTime(500);
      expect(requestRender.mock.calls.length).toBeGreaterThanOrEqual(4);
    }
    footer.dispose();
  });

  it('uses the normal render scheduler at 30fps while thinking', () => {
    vi.useFakeTimers();
    const { footer, requestRender } = makeFooter(baseState());

    footer.setState(baseState({ streamingPhase: 'thinking' }));
    vi.advanceTimersByTime(200);

    expect(requestRender.mock.calls.length).toBeGreaterThanOrEqual(5);
    footer.dispose();
  });

  it('stops ticking when the phase returns to idle and on dispose', () => {
    vi.useFakeTimers();
    const { footer, requestRender } = makeFooter(baseState());

    footer.setState(baseState({ streamingPhase: 'tool' }));
    vi.advanceTimersByTime(300);
    expect(requestRender.mock.calls.length).toBeGreaterThan(0);

    footer.setState(baseState({ streamingPhase: 'idle' }));
    requestRender.mockClear();
    vi.advanceTimersByTime(1000);
    expect(requestRender).not.toHaveBeenCalled();

    footer.setState(baseState({ streamingPhase: 'thinking' }));
    vi.advanceTimersByTime(100);
    footer.dispose();
    requestRender.mockClear();
    vi.advanceTimersByTime(1000);
    expect(requestRender).not.toHaveBeenCalled();
  });

  it('does not stack timers across rapid phase transitions', () => {
    vi.useFakeTimers();
    const { footer, requestRender } = makeFooter(baseState());
    for (const phase of ['waiting', 'thinking', 'tool', 'composing'] as const) {
      footer.setState(baseState({ streamingPhase: phase }));
    }

    requestRender.mockClear();
    vi.advanceTimersByTime(17);
    expect(requestRender.mock.calls.length).toBe(1);
    footer.dispose();
  });

  it('keeps the goal wall-clock badge ticking between goal.updated events', () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);
    const { footer } = makeFooter(
      baseState({
        goalActive: true,
        goal: {
          objective: 'test goal',
          turnsUsed: 3,
          wallClockMs: 5_000,
          wallClockBaseAt: now,
        },
      }),
    );

    const line0 = footer.render(200)[0];
    expect(line0).toContain('GOAL 5s · 3 turns');

    vi.advanceTimersByTime(2_500);
    const line1 = footer.render(200)[0];
    expect(line1).toContain('GOAL 7s · 3 turns');

    footer.dispose();
  });

  it('keeps ticking while a goal is active even when streaming is idle', () => {
    vi.useFakeTimers();
    const { footer, requestRender } = makeFooter(
      baseState({
        streamingPhase: 'idle',
        goalActive: true,
        goal: {
          objective: 'test goal',
          turnsUsed: 1,
          wallClockMs: 0,
          wallClockBaseAt: Date.now(),
        },
      }),
    );

    requestRender.mockClear();
    vi.advanceTimersByTime(500);
    expect(requestRender.mock.calls.length).toBeGreaterThanOrEqual(4);

    footer.setState(baseState({ streamingPhase: 'idle', goalActive: false, goal: null }));
    requestRender.mockClear();
    vi.advanceTimersByTime(500);
    expect(requestRender).not.toHaveBeenCalled();

    footer.dispose();
  });
});
