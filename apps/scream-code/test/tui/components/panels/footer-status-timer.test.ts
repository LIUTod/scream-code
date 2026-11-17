import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TUI } from '@liutod-scream/pi-tui';

import { FooterComponent } from '#/tui/components/chrome/footer';
import { darkColors } from '#/tui/theme/colors';
import { applyMotionEnv, resetMotion } from '#/tui/utils/motion';
import type { AppState } from '#/tui/types';

function baseState(overrides: Partial<AppState> = {}): AppState {
  return {
    model: 'scream-s3',
    workDir: '/tmp',
    sessionId: 'sess_1',
    permissionMode: 'yolo',
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

  it('ticks once a second — not at 30fps — when motion is off, so the clocks keep moving', () => {
    vi.useFakeTimers();
    applyMotionEnv({ SCREAM_MOTION: 'off' });
    try {
      const { footer, requestRender } = makeFooter(baseState({ streamingPhase: 'tool' }));
      vi.advanceTimersByTime(999);
      expect(requestRender).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(requestRender).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(3000);
      expect(requestRender).toHaveBeenCalledTimes(4);
      expect(vi.getTimerCount()).toBe(1);
      footer.dispose();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      resetMotion();
    }
  });

  it('stays quiet while idle even with motion off', () => {
    vi.useFakeTimers();
    applyMotionEnv({ SCREAM_MOTION: 'off' });
    try {
      const { footer, requestRender } = makeFooter(baseState());
      vi.advanceTimersByTime(5000);
      expect(requestRender).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      footer.dispose();
    } finally {
      resetMotion();
    }
  });

  it('the elapsed clock advances with motion off (it is information, not decoration)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    applyMotionEnv({ SCREAM_REDUCED_MOTION: '1' });
    try {
      const { footer } = makeFooter(
        baseState({ streamingPhase: 'waiting', streamingStartTime: Date.now() }),
      );
      const strip = (text: string): string => text.replaceAll(/\u001B\[[0-9;]*m/g, '');
      expect(strip(footer.render(120)[1] ?? '')).toContain('等待中 0s');
      vi.advanceTimersByTime(7000);
      expect(strip(footer.render(120)[1] ?? '')).toContain('等待中 7s');
      footer.dispose();
    } finally {
      resetMotion();
    }
  });

  it('keeps the goal wall-clock ticking with motion off', () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);
    applyMotionEnv({ SCREAM_MOTION: 'off' });
    try {
      const { footer, requestRender } = makeFooter(
        baseState({
          goalActive: true,
          goal: {
            objective: 'quiet',
            turnsUsed: 1,
            wallClockMs: 0,
            wallClockBaseAt: now,
            completionCriterion: null,
            status: 'active',
            tokensUsed: 0,
            inputTokens: null,
            outputTokens: null,
          },
        }),
      );
      requestRender.mockClear();
      vi.advanceTimersByTime(3000);
      expect(requestRender).toHaveBeenCalledTimes(3);
      footer.dispose();
    } finally {
      resetMotion();
    }
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
    vi.advanceTimersByTime(34); // one 30fps tick
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
          completionCriterion: null,
          status: "active",
          tokensUsed: 0,
          inputTokens: null,
          outputTokens: null,
        },
      }),
    );

    const line0 = footer.render(200)[1];
    expect(line0).toContain('目标 5s · 3轮');

    vi.advanceTimersByTime(2_500);
    const line1 = footer.render(200)[1];
    expect(line1).toContain('目标 7s · 3轮');

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
          completionCriterion: null,
          status: "active",
          tokensUsed: 0,
          inputTokens: null,
          outputTokens: null,
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

describe('FooterComponent - balance flash timer cleanup', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function makeFooter(state: AppState) {
    const requestRender = vi.fn();
    const ui = { requestRender } as unknown as TUI;
    const footer = new FooterComponent(state, darkColors, ui);
    return { footer, requestRender };
  }

  it('clears the balanceFlashTimer on dispose', () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    const { footer, requestRender } = makeFooter(baseState());

    // A fresh balanceUpdatedAt triggers the flash and arms the timer chain.
    footer.setState(baseState({ balanceUpdatedAt: 1_000 }));
    requestRender.mockClear();

    footer.dispose();

    // The dispose path must have disarmed the pending tick.
    expect(clearTimeoutSpy).toHaveBeenCalled();
    // No tick may fire after dispose — without the fix the 50ms chain
    // keeps calling requestRender until BALANCE_FLASH_MS elapses.
    vi.advanceTimersByTime(2_000);
    expect(requestRender).not.toHaveBeenCalled();
  });

  it('stops flashing after dispose even mid-animation', () => {
    vi.useFakeTimers();
    const { footer, requestRender } = makeFooter(baseState());

    footer.setState(baseState({ balanceUpdatedAt: 2_000 }));
    // Let the flash run a few ticks first.
    vi.advanceTimersByTime(200);
    expect(requestRender).toHaveBeenCalled();

    footer.dispose();
    requestRender.mockClear();
    vi.advanceTimersByTime(2_000);
    expect(requestRender).not.toHaveBeenCalled();
  });
});
