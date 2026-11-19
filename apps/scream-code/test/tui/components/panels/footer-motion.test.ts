import { visibleWidth } from '@liutod-scream/pi-tui';
import { setLocale } from '@scream-code/config';
import chalk from 'chalk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FooterComponent } from '#/tui/components/chrome/footer';
import { darkColors } from '#/tui/theme/colors';
import type { AppState } from '#/tui/types';
import { applyMotionEnv, resetMotion } from '#/tui/utils/motion';

const ANSI_SGR = /\u001B\[[0-9;]*m/g;
const strip = (text: string): string => text.replaceAll(ANSI_SGR, '');
function hexToSgr(hex: string): string {
  const value = hex.replace(/^#/, '');
  const [r, g, b] = [0, 2, 4].map((at) => Number.parseInt(value.slice(at, at + 2), 16));
  return `\u001B[38;2;${String(r)};${String(g)};${String(b)}m`;
}

function baseState(overrides: Partial<AppState> = {}): AppState {
  return {
    model: 'k2',
    workDir: '/tmp',
    sessionId: 'sess_1',
    permissionMode: 'yolo',
    planMode: 'off',
    thinkingLevel: 'off',
    contextUsage: 0.3,
    contextTokens: 30_000,
    maxContextTokens: 100_000,
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

const ui = { requestRender: () => {} } as never;
let level: typeof chalk.level;

beforeEach(() => {
  level = chalk.level;
  chalk.level = 3;
});
afterEach(() => {
  chalk.level = level;
  resetMotion();
  setLocale('zh');
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function renderAt(state: AppState, time: number, width = 100): string[] {
  vi.spyOn(Date, 'now').mockReturnValue(time);
  const footer = new FooterComponent(state, darkColors, ui);
  const rows = footer.render(width);
  footer.dispose();
  vi.restoreAllMocks();
  return rows;
}

const WORKING = { streamingStartTime: 1_699_999_990_000 } as const;

describe('FooterComponent — motion off', () => {
  it('draws a working model name in one steady colour instead of a moving glow', () => {
    applyMotionEnv({ SCREAM_MOTION: 'off' });
    for (const phase of ['thinking', 'waiting', 'composing', 'tool-args'] as const) {
      const state = baseState({ model: 'deepseek', streamingPhase: phase, ...WORKING });
      const first = renderAt(state, 1_700_000_000_000)[0]!;
      const later = renderAt(state, 1_700_000_000_000 + 137)[0]!;
      expect(later, phase).toBe(first);
      expect(first, phase).toContain(`${hexToSgr(darkColors.primary)}deepseek`);
    }
  });

  it('uses the cyan of a running tool, steady, for the tool phase', () => {
    applyMotionEnv({ SCREAM_MOTION: 'off' });
    const state = baseState({ model: 'deepseek', streamingPhase: 'tool', ...WORKING });
    const first = renderAt(state, 1_700_000_000_000)[0]!;
    expect(renderAt(state, 1_700_000_000_000 + 211)[0]).toBe(first);
    expect(first).toContain(`${hexToSgr(darkColors.planMode)}deepseek`);
  });

  it('with motion on the same name is not steady (the glow moves with the clock)', () => {
    const state = baseState({ model: 'deepseek', streamingPhase: 'thinking', ...WORKING });
    const frames = new Set(
      [0, 100, 200, 300, 400, 500].map((offset) => renderAt(state, 1_700_000_000_000 + offset)[0]),
    );
    expect(frames.size).toBeGreaterThan(1);
  });

  it('shows a steady dot rather than a spinner in the work status', () => {
    applyMotionEnv({ SCREAM_REDUCED_MOTION: '1' });
    const state = baseState({ streamingPhase: 'thinking', ...WORKING });
    const glyphs = new Set(
      [0, 60, 120, 180, 240, 300, 360, 420].map((offset) => {
        const row = strip(renderAt(state, 1_700_000_000_000 + offset)[1]!);
        return row.slice(row.indexOf('思考中') - 2, row.indexOf('思考中') - 1);
      }),
    );
    expect([...glyphs]).toEqual(['●']);
  });

  it('with motion on the status glyph does spin', () => {
    const state = baseState({ streamingPhase: 'thinking', ...WORKING });
    const glyphs = new Set(
      [0, 60, 120, 180, 240, 300, 360, 420].map((offset) => {
        const row = strip(renderAt(state, 1_700_000_000_000 + offset)[1]!);
        return row.slice(row.indexOf('思考中') - 2, row.indexOf('思考中') - 1);
      }),
    );
    expect(glyphs.size).toBeGreaterThan(2);
  });

  it('does not start a balance flash', () => {
    vi.useFakeTimers();
    applyMotionEnv({ SCREAM_MOTION: 'off' });
    const footer = new FooterComponent(baseState({ balanceUpdatedAt: 1 }), darkColors, ui);
    footer.setState(baseState({ balanceUpdatedAt: 2 }));
    expect(vi.getTimerCount()).toBe(0);
    footer.dispose();
  });

  it('with motion on a balance refresh does start the flash', () => {
    vi.useFakeTimers();
    const footer = new FooterComponent(baseState({ balanceUpdatedAt: 1 }), darkColors, ui);
    footer.setState(baseState({ balanceUpdatedAt: 2 }));
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    footer.dispose();
  });
});

describe('FooterComponent — exit hint on a narrow terminal', () => {
  const HINT = 'Press Ctrl-C again to exit'; // 26 columns

  function line1(model: string, width: number): string {
    const footer = new FooterComponent(baseState({ model }), darkColors, ui);
    footer.setTransientHint(HINT);
    const row = footer.render(width)[0]!;
    footer.dispose();
    return row;
  }

  it('shows the whole hint wherever it fits, giving up the model name before the hint', () => {
    for (let width = 26; width <= 80; width++) {
      const row = line1('k2', width);
      expect(strip(row), `width ${String(width)}`).toContain(HINT);
      expect(visibleWidth(row), `width ${String(width)}`).toBe(width);
    }
    // `📟️ k2` (5) + 3 + hint (26) = 34: the model is on the row from 34 columns up…
    expect(strip(line1('k2', 34))).toContain('📟️ k2');
    // …and gone below it, with the hint untouched.
    expect(strip(line1('k2', 33))).not.toContain('k2');
    expect(strip(line1('k2', 26)).trim()).toBe(HINT);
  });

  it('cuts a long model name down before it drops it, hint intact throughout', () => {
    const wide = strip(line1('scream-k2-5', 60));
    expect(wide).toContain('📟️ scream-k2-5');
    expect(wide).toContain(HINT);
    // 8 columns (`📟️ scre…`) + 3 + 26 = 37 is the narrowest row that still names the model.
    const narrowest = strip(line1('scream-k2-5', 37));
    expect(narrowest).toContain('📟️ scre…');
    expect(narrowest).toContain(HINT);
    expect(strip(line1('scream-k2-5', 36))).not.toContain('📟️');
    expect(strip(line1('scream-k2-5', 36))).toContain(HINT);
  });

  it('cuts the hint itself only when the terminal is narrower than the hint', () => {
    const row = strip(line1('k2', 20));
    expect(visibleWidth(row)).toBe(20);
    expect(row.startsWith('Press')).toBe(true);
    expect(row).toContain('…');
  });

  it('an empty hint is no hint: the gauge shows and the model name stays undroppable', () => {
    const footer = new FooterComponent(baseState({ model: 'scream-k2-5' }), darkColors, ui);
    footer.setTransientHint('');
    // Too narrow for even the shortest model name (`📟️ scre…` is 8 columns): an
    // undroppable name is cut to fit, a droppable one would vanish.
    const row = strip(footer.render(6)[0]!);
    expect(row).toContain('📟️');
    expect(row).not.toContain('Press');
    expect(strip(footer.render(60)[0]!)).toContain('📨 Context：');
    footer.dispose();
  });

  it('the gauge returns as soon as the hint clears', () => {
    const footer = new FooterComponent(baseState({ model: 'k2' }), darkColors, ui);
    footer.setTransientHint(HINT);
    footer.setTransientHint(null);
    expect(strip(footer.render(60)[0]!)).toContain('📨 Context：');
    footer.dispose();
  });
});

describe('FooterComponent — plan badge slot', () => {
  const cols = (planMode: AppState['planMode'], width = 120): number[] => {
    const footer = new FooterComponent(baseState({ planMode, rlmEnabled: true, wolfpackMode: true }), darkColors, ui);
    const row = strip(footer.render(width)[1]!);
    footer.dispose();
    return ['RLM', '群狼', 'Wolfpack'].map((label) => row.indexOf(label));
  };

  it('Chinese: 计划 and 融合 are the same width, so nothing after them moves', () => {
    const plan = cols('plan');
    expect(plan[0]).toBeGreaterThan(0);
    expect(cols('fusionplan')).toEqual(plan);
  });

  it('English: Plan is padded to the width of Fusion, so nothing after it moves', () => {
    setLocale('en');
    const plan = cols('plan');
    expect(plan[2]).toBeGreaterThan(0);
    expect(cols('fusionplan')).toEqual(plan);
    const footer = new FooterComponent(baseState({ planMode: 'plan', rlmEnabled: true }), darkColors, ui);
    expect(strip(footer.render(120)[1]!)).toContain('Plan    RLM'); // 'Plan' + 2 pad + 2 gap
    footer.dispose();
  });
});
