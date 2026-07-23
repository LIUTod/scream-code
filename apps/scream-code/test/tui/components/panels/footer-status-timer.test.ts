import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TUI } from '@liutod-scream/pi-tui';

import { FooterComponent } from '#/tui/components/chrome/footer';
import { darkColors } from '#/tui/theme/colors';
import type { AppState } from '#/tui/types';

function baseState(overrides: Partial<AppState> = {}): AppState {
  return {
    model: 'k2',
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

describe('FooterComponent — active status animation', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeFooter(state: AppState) {
    const requestRender = vi.fn();
    const requestComponentRender = vi.fn();
    const ui = { requestRender, requestComponentRender } as unknown as TUI;
    const footer = new FooterComponent(state, darkColors, ui);
    return { footer, requestRender, requestComponentRender };
  }

  it('stays quiet while idle and ticks independently in every active phase', () => {
    vi.useFakeTimers();
    const { footer, requestRender, requestComponentRender } = makeFooter(baseState());

    vi.advanceTimersByTime(500);
    expect(requestRender).not.toHaveBeenCalled();

    for (const phase of ['waiting', 'tool', 'composing'] as const) {
      footer.setState(baseState({ streamingPhase: phase }));
      requestRender.mockClear();
      vi.advanceTimersByTime(500);
      expect(requestRender.mock.calls.length).toBeGreaterThanOrEqual(4);
    }
    expect(requestComponentRender).not.toHaveBeenCalled();
    footer.dispose();
  });

  it('uses the normal render scheduler at 30fps while thinking', () => {
    vi.useFakeTimers();
    const { footer, requestRender, requestComponentRender } = makeFooter(baseState());

    footer.setState(baseState({ streamingPhase: 'thinking' }));
    vi.advanceTimersByTime(200);

    expect(requestRender.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(requestComponentRender).not.toHaveBeenCalled();
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
    vi.advanceTimersByTime(120);
    expect(requestRender.mock.calls.length).toBe(1);
    footer.dispose();
  });
});
