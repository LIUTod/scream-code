import { describe, it, expect, vi, afterEach } from 'vitest';
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

describe('FooterComponent — status timer', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeFooter(state: AppState) {
    const requestComponentRender = vi.fn();
    const ui = { requestRender: vi.fn(), requestComponentRender } as unknown as TUI;
    const footer = new FooterComponent(state, darkColors, ui);
    return { footer, requestComponentRender };
  }

  it('stays quiet while idle and ticks on entering a streaming phase', () => {
    vi.useFakeTimers();
    const { footer, requestComponentRender } = makeFooter(baseState());

    vi.advanceTimersByTime(1000);
    expect(requestComponentRender).not.toHaveBeenCalled();

    footer.setState(baseState({ streamingPhase: 'waiting' }));
    vi.advanceTimersByTime(500);
    expect(requestComponentRender.mock.calls.length).toBeGreaterThan(0);
    footer.dispose();
  });

  it('ticks with the component as the render target', () => {
    vi.useFakeTimers();
    const { footer, requestComponentRender } = makeFooter(baseState());
    footer.setState(baseState({ streamingPhase: 'thinking' }));
    vi.advanceTimersByTime(200);
    expect(requestComponentRender).toHaveBeenCalledWith(footer);
    footer.dispose();
  });

  it('stops ticking when the phase returns to idle and on dispose', () => {
    vi.useFakeTimers();
    const { footer, requestComponentRender } = makeFooter(baseState());

    footer.setState(baseState({ streamingPhase: 'composing' }));
    vi.advanceTimersByTime(300);
    expect(requestComponentRender.mock.calls.length).toBeGreaterThan(0);

    footer.setState(baseState({ streamingPhase: 'idle' }));
    requestComponentRender.mockClear();
    vi.advanceTimersByTime(1000);
    expect(requestComponentRender).not.toHaveBeenCalled();

    footer.setState(baseState({ streamingPhase: 'tool' }));
    vi.advanceTimersByTime(300);
    expect(requestComponentRender.mock.calls.length).toBeGreaterThan(0);
    footer.dispose();
    requestComponentRender.mockClear();
    vi.advanceTimersByTime(1000);
    expect(requestComponentRender).not.toHaveBeenCalled();
  });

  it('does not stack timers across rapid phase transitions', () => {
    vi.useFakeTimers();
    const { footer, requestComponentRender } = makeFooter(baseState());
    for (const phase of ['waiting', 'thinking', 'tool', 'composing'] as const) {
      footer.setState(baseState({ streamingPhase: phase }));
    }
    // One interval worth of time must produce at most a handful of ticks —
    // stacked timers would multiply the call count.
    requestComponentRender.mockClear();
    vi.advanceTimersByTime(120);
    expect(requestComponentRender.mock.calls.length).toBeLessThanOrEqual(2);
    footer.dispose();
  });
});
