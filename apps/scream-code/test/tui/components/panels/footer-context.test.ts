import { describe, it, expect, vi } from 'vitest';
import { visibleWidth } from '@liutod-scream/pi-tui';
import chalk from 'chalk';

import { FooterComponent } from '#/tui/components/chrome/footer';
import { darkColors } from '#/tui/theme/colors';
import type { AppState } from '#/tui/types';

const ANSI_SGR = /\u001B\[[0-9;]*m/g;
function strip(text: string): string {
  return text.replaceAll(ANSI_SGR, '');
}

function hexToSgr(hex: string): string {
  const value = hex.replace(/^#/, '');
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return `\u001B[38;2;${String(r)};${String(g)};${String(b)}m`;
}

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

const uiMock = { requestRender: () => {} } as any;

function makeFooter(state: AppState) {
  return new FooterComponent(state, darkColors, uiMock);
}

describe('FooterComponent — context NaN resilience', () => {
  it('NaN usage → renders 0.0% (never literal "NaN%")', () => {
    const fc = makeFooter(baseState({ contextUsage: Number.NaN }));
    const out = strip(fc.render(120).join(''));
    expect(out).not.toMatch(/NaN/);
    expect(out).toContain('▱▱▱▱▱▱▱▱▱▱');
  });

  it('undefined-ish (coerced) usage → renders 0.0%', () => {
    const fc = makeFooter(
      baseState({ contextUsage: undefined as unknown as number }),
    );
    const out = strip(fc.render(120).join(''));
    expect(out).not.toMatch(/NaN/);
    expect(out).toContain('▱▱▱▱▱▱▱▱▱▱');
  });

  it('clamps ratios above 1.0 → renders 100.0%', () => {
    const fc = makeFooter(baseState({ contextUsage: 1.5 }));
    const out = strip(fc.render(120).join(''));
    expect(out).toContain('▰▰▰▰▰▰▰▰▰▰');
  });

  it('ratio 0.427 → renders 42.7%', () => {
    const fc = makeFooter(baseState({ contextUsage: 0.427 }));
    const out = strip(fc.render(200).join(''));
    expect(out).toContain('▰▰▰▰▱▱▱▱▱▱');
  });

  it('reports the percentage only — absolute token counts are gone', () => {
    const fc = makeFooter(
      baseState({ contextUsage: 0, contextTokens: 500, maxContextTokens: 0 }),
    );
    const out = strip(fc.render(200).join(''));
    expect(out).not.toMatch(/Infinity|NaN/);
    expect(out).toContain('▱▱▱▱▱▱▱▱▱▱');
    expect(out).toContain('📨 Context：');
    // Neither the raw count nor the window size is printed any more.
    expect(out).not.toContain('500/');
    expect(out).not.toContain('0/0');
  });

  it('setState updates visible model and context values', () => {
    const footer = makeFooter(baseState({ model: 'k2', contextUsage: 0 }));

    footer.setState(baseState({ model: 'scream-k2-5', contextUsage: 0.5 }));

    const out = strip(footer.render(200).join(''));
    expect(out).toContain('scream-k2-5');
    expect(out).not.toContain(' k2 ');
    expect(out).toContain('▰▰▰▰▰▱▱▱▱▱');
  });

  it('renders a water-level progress bar ahead of the percentage', () => {
    const fc = makeFooter(
      baseState({ contextUsage: 0.288, contextTokens: 288_000, maxContextTokens: 1_000_000 }),
    );
    const out = strip(fc.render(200).join(''));
    // 28.8% × 10 cells = 2.88 → 2 filled cells (floored).
    expect(out).toContain('📨 Context：▰▰▱▱▱▱▱▱▱▱ 28.8%');
  });

  it('keeps at least one lit cell for a tiny non-zero usage', () => {
    const out = strip(
      makeFooter(baseState({ contextUsage: 0.005 })).render(200).join(''),
    );
    // 0.5% would floor to zero cells; an empty bar beside "0.5%" reads as a bug.
    expect(out).toContain('📨 Context：▰▱▱▱▱▱▱▱▱▱ 0.5%');
  });

  it('renders an all-empty bar at 0% and an all-filled bar at >=100%', () => {
    const empty = strip(makeFooter(baseState({ contextUsage: 0 })).render(200).join(''));
    expect(empty).toContain('▱▱▱▱▱▱▱▱▱▱');
    const full = strip(makeFooter(baseState({ contextUsage: 1.5 })).render(200).join(''));
    expect(full).toContain('▰▰▰▰▰▰▰▰▰▰');
  });

  it('does not show a thinking label in the footer', () => {
    const on = makeFooter(baseState({ model: 'k2', thinkingLevel: 'high' }));

    expect(strip(on.render(120)[0]!)).not.toContain('思考中');
  });

  it('keeps active status animation out of red and pink hues', () => {
    const previousLevel = chalk.level;
    chalk.level = 3;
    const now = vi.spyOn(Date, 'now').mockReturnValue(2_000);
    try {
      const footer = makeFooter(
        baseState({ streamingPhase: 'thinking', streamingStartTime: 1_000 }),
      );
      const out = footer.render(200).join('');

      expect(strip(out)).toContain('思考中');
      expect(out).toContain(hexToSgr('#4ADE80'));
      expect(out).not.toContain(hexToSgr('#FF6B9D'));
      footer.dispose();
    } finally {
      now.mockRestore();
      chalk.level = previousLevel;
    }
  });

  it('renders transient hints replacing the status area', () => {
    const footer = makeFooter(baseState());

    footer.setTransientHint('Press Ctrl-C again to exit');

    const [line1] = footer.render(120);
    expect(strip(line1 ?? '')).toContain('Press Ctrl-C again to exit');
  });

  it('keeps the context gauge on line 1 and the run strip on line 2', () => {
    const footer = makeFooter(baseState());

    const [line1, line2] = footer.render(120);
    expect(strip(line1 ?? '')).toContain('📨 Context：');
    expect(strip(line2 ?? '')).toContain('↓ Hitr: --');
    expect(strip(line2 ?? '')).toContain('Line:');
    // The gauge no longer shares a row with the hit rate.
    expect(strip(line2 ?? '')).not.toContain('Context');
  });

  it('renders plan badge on line 2 in plan mode', () => {
    const footer = makeFooter(baseState({ planMode: 'plan' }));
    const [line1, line2] = footer.render(120);
    expect(strip(line1 ?? '')).not.toMatch(/计划/);
    expect(strip(line2 ?? '')).toMatch(/计划/);
  });

  it('renders fusion badge on line 2 in fusion plan mode', () => {
    const footer = makeFooter(baseState({ planMode: 'fusionplan' }));
    const [line1, line2] = footer.render(120);
    expect(strip(line1 ?? '')).not.toMatch(/融合计划/);
    expect(strip(line2 ?? '')).toMatch(/融合计划/);
  });

  it('colors context usage with textDim when below warning threshold', () => {
    const previousLevel = chalk.level;
    chalk.level = 3;
    try {
      const fc = makeFooter(
        baseState({ contextUsage: 0.5, contextTokens: 50_000, maxContextTokens: 200_000 }),
      );
      const out = fc.render(200).join('');
      expect(out).toContain(hexToSgr(darkColors.textDim));
      expect(out).not.toContain(hexToSgr(darkColors.warning));
      expect(out).not.toContain(hexToSgr(darkColors.error));
    } finally {
      chalk.level = previousLevel;
    }
  });

  it('colors the whole gauge — label, percentage and bar — as one span', () => {
    const previousLevel = chalk.level;
    chalk.level = 3;
    try {
      const fc = makeFooter(
        baseState({ contextUsage: 0.5, contextTokens: 50_000, maxContextTokens: 200_000 }),
      );
      const out = fc.render(200).join('');
      // The reset must come right after the bar, i.e. the bar is inside the
      // usage colour like the rest of the reading.
      expect(out).toContain(
        `${hexToSgr(darkColors.textDim)}📨 Context：▰▰▰▰▰▱▱▱▱▱ 50.0%\u001B[39m`,
      );
    } finally {
      chalk.level = previousLevel;
    }
  });

  it('uses a 6-cell bar between 52 and 67 columns and none below 52', () => {
    const footer = makeFooter(
      baseState({ contextUsage: 0.5, contextTokens: 50_000, maxContextTokens: 200_000 }),
    );
    const at60 = strip(footer.render(60)[0] ?? '');
    expect(at60).toContain('📨 Context：▰▰▰▱▱▱ 50.0%');
    expect(visibleWidth(at60)).toBe(60);

    const at40 = strip(footer.render(40)[0] ?? '');
    expect(at40).toContain('📨 Context：50.0%');
    expect(at40).not.toContain('▰');
    expect(at40).not.toContain('▱');
  });

  it('keeps the gauge flush against the right edge on line 1', () => {
    const footer = makeFooter(
      baseState({ contextUsage: 0.5, contextTokens: 50_000, maxContextTokens: 200_000 }),
    );
    const line1 = footer.render(60)[0] ?? '';
    expect(strip(line1).endsWith('📨 Context：▰▰▰▱▱▱ 50.0%')).toBe(true);
    expect(visibleWidth(line1)).toBe(60);
  });

  it('colors context usage with warning color at 60-90%', () => {
    const previousLevel = chalk.level;
    chalk.level = 3;
    try {
      const fc = makeFooter(
        baseState({ contextUsage: 0.8, contextTokens: 160_000, maxContextTokens: 200_000 }),
      );
      const out = fc.render(200).join('');
      expect(out).toContain(hexToSgr(darkColors.warning));
      expect(out).not.toContain(hexToSgr(darkColors.error));
    } finally {
      chalk.level = previousLevel;
    }
  });

  it('colors context usage with error color at >= 90%', () => {
    const previousLevel = chalk.level;
    chalk.level = 3;
    try {
      const fc = makeFooter(
        baseState({ contextUsage: 0.95, contextTokens: 190_000, maxContextTokens: 200_000 }),
      );
      const out = fc.render(200).join('');
      expect(out).toContain(hexToSgr(darkColors.error));
      expect(out).not.toContain(hexToSgr(darkColors.warning));
    } finally {
      chalk.level = previousLevel;
    }
  });
});

describe('FooterComponent — two-line layout', () => {
  it('always renders exactly two rows, at every width', () => {
    for (const width of [0, 1, 2, 3, 5, 10, 16, 20, 24, 40, 52, 68, 120, 200]) {
      const footer = makeFooter(
        baseState({ contextUsage: 0.5, contextTokens: 50_000, maxContextTokens: 200_000 }),
      );
      const lines = footer.render(width);
      expect(lines).toHaveLength(2);
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      footer.dispose();
    }
  });

  it('right-aligns the context readout on line 1', () => {
    const footer = makeFooter(
      baseState({ contextUsage: 0.288, contextTokens: 288_000, maxContextTokens: 1_000_000 }),
    );
    const [line1, line2] = footer.render(120);
    // Envelope mark + `Context：` label, then bar, then the percentage.
    expect(strip(line1!)).toContain('📨 Context：▰▰▱▱▱▱▱▱▱▱ 28.8%');
    // Right-aligned to the terminal edge: no padding after the bar.
    expect(strip(line1!).endsWith('▰▰▱▱▱▱▱▱▱▱ 28.8%')).toBe(true);
    expect(strip(line2!)).not.toContain('Context');
    expect(visibleWidth(line1!)).toBe(120);
  });

  it('tracks the context ratio as it changes between renders', () => {
    const footer = makeFooter(
      baseState({ contextUsage: 0.1, contextTokens: 100_000, maxContextTokens: 1_000_000 }),
    );
    expect(strip(footer.render(120)[0] ?? '')).toContain('📨 Context：');

    // Live path: `agent.status.updated` patches appState.contextUsage, the TUI
    // re-runs footer.setState(), and the next frame must show the new ratio.
    footer.setState(
      baseState({ contextUsage: 0.62, contextTokens: 620_000, maxContextTokens: 1_000_000 }),
    );
    expect(strip(footer.render(120)[0] ?? '')).toContain('📨 Context：');

    footer.setState(
      baseState({ contextUsage: 0.95, contextTokens: 950_000, maxContextTokens: 1_000_000 }),
    );
    const line = strip(footer.render(120)[0] ?? '');
    expect(line).toContain('📨 Context：');
    // The bar follows the same value: 95% of 10 cells = 9 filled (8 deep +
    // 1 foam), 1 empty.
    // 95% floors to 9 filled cells; the row still ends at the bar.
    expect(line).toMatch(/📨 Context：[▰▱]{10} 95\.0%$/);

    footer.dispose();
  });

  it('drops the bar but keeps the percentage on a narrow terminal', () => {
    const footer = makeFooter(
      baseState({ contextUsage: 0.5, contextTokens: 50_000, maxContextTokens: 200_000 }),
    );
    // 40 columns: bar collapses, so the bar-less template must not leave the
    // double space the collapsed bar used to occupy.
    const line2 = strip(footer.render(40)[0]!);
    expect(line2).toContain('📨 Context：50.0%');
    expect(line2).not.toContain('Context: ');
  });

  it('lets a transient hint take the line-1 right side while line 2 keeps the channel', () => {
    const footer = makeFooter(
      baseState({ contextUsage: 0.288, contextTokens: 288_000, maxContextTokens: 1_000_000 }),
    );
    footer.setTransientHint('Press Ctrl-C again to exit');
    const [line1, line2] = footer.render(120);
    expect(strip(line1!)).toContain('Press Ctrl-C again to exit');
    // The hint is transient and owns line 1's right side; the gauge returns
    // as soon as it clears, and line 2 is untouched.
    expect(strip(line1!)).not.toContain('Context');
    expect(strip(line2!)).toContain('Line:');
  });
});

describe('FooterComponent — badge order', () => {
  it('marks the mode badges with their emoji (🗒️ plan, 🪐 rlm, 🐺 wolfpack)', () => {
    const footer = makeFooter(
      baseState({ planMode: 'plan', rlmEnabled: true, wolfpackMode: true }),
    );
    const line2 = strip(footer.render(160)[1] ?? '');
    expect(line2).toContain('🗒️ 计划');
    expect(line2).toContain('🪐 RLM');
    expect(line2).toContain('🐺 群狼');
    expect(line2.indexOf('🗒️')).toBeLessThan(line2.indexOf('🪐'));
    expect(line2.indexOf('🪐')).toBeLessThan(line2.indexOf('🐺'));
  });

  it('separates the identity strip (line 1) from the mode badges (line 2)', () => {
    const footer = makeFooter(
      baseState({
        model: 'scream-k2-5',
        availableModels: {
          'scream-k2-5': { displayName: 'scream-k2-5', model: 'scream-k2-5' } as any,
        },
        wolfpackMode: true,
        rlmEnabled: true,
        planMode: 'plan',
        goalActive: true,
        goal: {
          objective: 'footer order',
          status: 'active',
          turnsUsed: 3,
          wallClockMs: 0,
          wallClockBaseAt: Date.now(),
          completionCriterion: null,
          tokensUsed: 0,
          inputTokens: null,
          outputTokens: null,
        },
        providerBalance: { currency: 'CNY', totalBalance: '12.34' },
      }),
    );

    const [first, second] = footer.render(200).map(strip);
    // Line 1 is the identity strip: model + balance only.
    let previous = -1;
    for (const token of ['scream-k2-5', '¥12.34']) {
      const at = first!.indexOf(token);
      expect(at, `missing or out of order: ${token}`).toBeGreaterThan(previous);
      previous = at;
    }
    // Line 2 opens with the hit rate, then plan → rlm → wolfpack → goal.
    expect(first).not.toContain('群狼');
    expect(first).not.toContain('GOAL');
    expect(second).toMatch(/^↓ Hitr:/);
    previous = -1;
    for (const token of ['Hitr:', '计划', 'RLM', '群狼', 'GOAL']) {
      const at = second!.indexOf(token);
      expect(at, `missing or out of order on line 2: ${token}`).toBeGreaterThan(previous);
      previous = at;
    }
  });
});
