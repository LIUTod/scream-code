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

const uiMock = { requestRender: () => {} } as any;

function makeFooter(state: AppState) {
  return new FooterComponent(state, darkColors, uiMock);
}

describe('FooterComponent — context NaN resilience', () => {
  it('NaN usage → renders 0% (never literal "NaN%")', () => {
    const fc = makeFooter(baseState({ contextUsage: Number.NaN }));
    const out = strip(fc.render(120).join(''));
    expect(out).not.toMatch(/NaN/);
    expect(out).toContain('📨 Context  ────────── 0%');
  });

  it('undefined-ish (coerced) usage → renders 0%', () => {
    const fc = makeFooter(
      baseState({ contextUsage: undefined as unknown as number }),
    );
    const out = strip(fc.render(120).join(''));
    expect(out).not.toMatch(/NaN/);
    expect(out).toContain('📨 Context  ────────── 0%');
  });

  it('clamps ratios above 1.0 → renders 100%', () => {
    const fc = makeFooter(baseState({ contextUsage: 1.5 }));
    const out = strip(fc.render(120).join(''));
    expect(out).toContain('━━━━━━━━━━ 100%');
  });

  it('ratio 0.427 → renders 42% (floored, never overstated)', () => {
    const fc = makeFooter(baseState({ contextUsage: 0.427 }));
    const out = strip(fc.render(200).join(''));
    expect(out).toContain('📨 Context  ━━━━────── 42%');
  });

  it('reports the percentage only — absolute token counts are gone', () => {
    const fc = makeFooter(
      baseState({ contextUsage: 0, contextTokens: 500, maxContextTokens: 0 }),
    );
    const out = strip(fc.render(200).join(''));
    expect(out).not.toMatch(/Infinity|NaN/);
    expect(out).toContain('📨 Context  ────────── 0%');
    expect(out).toContain('📨 Context  ');
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
    expect(out).toContain('━━━━━─────');
  });

  it('renders a water-level progress bar ahead of the percentage', () => {
    const fc = makeFooter(
      baseState({ contextUsage: 0.288, contextTokens: 288_000, maxContextTokens: 1_000_000 }),
    );
    const out = strip(fc.render(200).join(''));
    // 28.8% × 10 cells = 2.88 → 2 filled cells (floored).
    expect(out).toContain('📨 Context  ━━──────── 28%');
  });

  it('keeps at least one lit cell for a tiny non-zero usage', () => {
    const out = strip(
      makeFooter(baseState({ contextUsage: 0.005 })).render(200).join(''),
    );
    // 0.5% would floor to zero cells; an empty bar beside "<1%" reads as a bug.
    expect(out).toContain('📨 Context  ━───────── <1%');
  });

  it('renders an all-empty bar at 0% and an all-filled bar at >=100%', () => {
    const empty = strip(makeFooter(baseState({ contextUsage: 0 })).render(200).join(''));
    expect(empty).toContain('📨 Context  ────────── 0%');
    const full = strip(makeFooter(baseState({ contextUsage: 1.5 })).render(200).join(''));
    expect(full).toContain('📨 Context  ━━━━━━━━━━ 100%');
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
    expect(strip(line1 ?? '')).toContain('📨 Context  ');
    expect(strip(line2 ?? '')).toContain('↓ Cache hit: --');
    expect(strip(line2 ?? '')).toContain('Line:');
    // The gauge no longer shares a row with the hit rate.
    expect(strip(line2 ?? '')).not.toContain('Context');
  });

  it('renders plan badge on line 2 in plan mode', () => {
    const footer = makeFooter(baseState({ planMode: 'plan' }));
    const [line1, line2] = footer.render(120);
    expect(strip(line1 ?? '')).not.toMatch(/计划/);
    expect(strip(line2 ?? '')).toMatch(/计划/);
    expect(strip(line2 ?? '')).not.toMatch(/融合/);
  });

  it('renders fusion badge on line 2 in fusion plan mode', () => {
    const footer = makeFooter(baseState({ planMode: 'fusionplan' }));
    const [line1, line2] = footer.render(120);
    expect(strip(line1 ?? '')).not.toMatch(/融合/);
    expect(strip(line2 ?? '')).toMatch(/融合/);
    // The fusion switch replaces the plan label rather than joining it.
    expect(strip(line2 ?? '')).not.toContain('计划');
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

  it('keeps the label dim, the used share and the reading in the usage colour, the rest as a dim track', () => {
    const previousLevel = chalk.level;
    chalk.level = 3;
    try {
      const fc = makeFooter(
        baseState({ contextUsage: 0.5, contextTokens: 50_000, maxContextTokens: 200_000 }),
      );
      const out = fc.render(200).join('');
      expect(out).toContain(`${hexToSgr(darkColors.textDim)}📨 Context\u001B[39m`);
      expect(out).toContain(`${hexToSgr(darkColors.text)}━━━━━\u001B[39m${hexToSgr(darkColors.border)}─────\u001B[39m`);
      expect(out).toContain(`${hexToSgr(darkColors.text)}50%\u001B[39m`);
    } finally {
      chalk.level = previousLevel;
    }
  });

  it('shrinks the bar only as far as the row needs: 10 cells, then 6, then none', () => {
    // `📟️ scream-k2-5` is 14 columns; the gauge is 26 / 22 / 15 columns wide with a
    // 10-cell / 6-cell / no bar, and the row keeps 3 columns between the two.
    const footer = makeFooter(
      baseState({
        model: 'scream-k2-5',
        contextUsage: 0.5,
        contextTokens: 50_000,
        maxContextTokens: 200_000,
      }),
    );
    const at = (width: number): string => strip(footer.render(width)[0] ?? '');
    expect(at(43)).toContain('📨 Context  ━━━━━───── 50%');
    expect(at(42)).toContain('📨 Context  ━━━─── 50%');
    expect(at(39)).toContain('📨 Context  ━━━─── 50%');
    expect(at(38)).toContain('📨 Context  50%');
    expect(at(38)).not.toMatch(/[━─]/);
    expect(at(32)).toContain('📟️ scream-k2-5');
    expect(at(32)).toContain('📨 Context  50%');
    // Below that the model name is cut instead — the gauge keeps its percentage.
    expect(at(31)).toContain('📨 Context  50%');
    expect(at(31)).toContain('…');
    for (const width of [43, 42, 39, 38, 32, 31]) expect(visibleWidth(at(width))).toBe(width);
  });

  it('keeps the full 10-cell bar on a roomy 60-column row', () => {
    const footer = makeFooter(
      baseState({ contextUsage: 0.5, contextTokens: 50_000, maxContextTokens: 200_000 }),
    );
    expect(strip(footer.render(60)[0] ?? '')).toContain('📨 Context  ━━━━━───── 50%');
  });

  it('keeps the gauge flush against the right edge on line 1', () => {
    const footer = makeFooter(
      baseState({ contextUsage: 0.5, contextTokens: 50_000, maxContextTokens: 200_000 }),
    );
    const line1 = footer.render(60)[0] ?? '';
    expect(strip(line1).endsWith('📨 Context  ━━━━━───── 50%')).toBe(true);
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

describe('FooterComponent — context color on a 1M window', () => {
  function outFor(usage: number, tokens: number, windowTokens: number): string {
    const previousLevel = chalk.level;
    chalk.level = 3;
    try {
      const fc = makeFooter(
        baseState({ contextUsage: usage, contextTokens: tokens, maxContextTokens: windowTokens }),
      );
      return fc.render(200).join('');
    } finally {
      chalk.level = previousLevel;
    }
  }

  it('turns warning at 400K tokens, not at 600K', () => {
    const out = outFor(0.45, 450_000, 1_000_000);
    expect(out).toContain(hexToSgr(darkColors.warning));
    expect(out).not.toContain(hexToSgr(darkColors.error));
  });

  it('turns error at 700K tokens, not at 900K', () => {
    const out = outFor(0.75, 750_000, 1_000_000);
    expect(out).toContain(hexToSgr(darkColors.error));
  });

  it('stays quiet below 400K on a 1M window', () => {
    const out = outFor(0.3, 300_000, 1_000_000);
    expect(out).not.toContain(hexToSgr(darkColors.warning));
    expect(out).not.toContain(hexToSgr(darkColors.error));
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
    // Envelope mark + `Context` label, then the gauge, then the percentage.
    expect(strip(line1!)).toContain('📨 Context  ━━──────── 28%');
    // Right-aligned to the terminal edge: no padding after the bar.
    expect(strip(line1!).endsWith('━━──────── 28%')).toBe(true);
    expect(strip(line2!)).not.toContain('Context');
    expect(visibleWidth(line1!)).toBe(120);
  });

  it('tracks the context ratio as it changes between renders', () => {
    const footer = makeFooter(
      baseState({ contextUsage: 0.1, contextTokens: 100_000, maxContextTokens: 1_000_000 }),
    );
    expect(strip(footer.render(120)[0] ?? '')).toContain('📨 Context  ━───────── 10%');

    // Live path: `agent.status.updated` patches appState.contextUsage, the TUI
    // re-runs footer.setState(), and the next frame must show the new ratio.
    footer.setState(
      baseState({ contextUsage: 0.62, contextTokens: 620_000, maxContextTokens: 1_000_000 }),
    );
    expect(strip(footer.render(120)[0] ?? '')).toContain('📨 Context  ━━━━━━──── 62%');

    footer.setState(
      baseState({ contextUsage: 0.95, contextTokens: 950_000, maxContextTokens: 1_000_000 }),
    );
    const line = strip(footer.render(120)[0] ?? '');
    // 95% floors to 9 filled cells; the row ends at the reading.
    expect(line).toMatch(/📨 Context {2}━{9}─ 95%$/);

    footer.dispose();
  });

  it('drops the bar but keeps the percentage on a narrow terminal', () => {
    const footer = makeFooter(
      baseState({
        model: 'scream-k2-5',
        contextUsage: 0.5,
        contextTokens: 50_000,
        maxContextTokens: 200_000,
      }),
    );
    // 38 columns: the model name takes 14, so only the bar-less gauge fits and
    // the bar-less gauge must not leave the extra space the bar used to occupy.
    const line1 = strip(footer.render(38)[0]!);
    expect(line1).toContain('📨 Context  50%');
    expect(line1).not.toMatch(/Context {3}/);
    expect(line1).not.toMatch(/[━─]/);
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

describe('FooterComponent — mode switches', () => {
  function line2Of(overrides: Partial<AppState>, width = 200): string {
    const footer = makeFooter(baseState(overrides));
    const line = footer.render(width)[1] ?? '';
    footer.dispose();
    return line;
  }

  function withTrueColor<T>(run: () => T): T {
    const previousLevel = chalk.level;
    chalk.level = 3;
    try {
      return run();
    } finally {
      chalk.level = previousLevel;
    }
  }

  it('shows no mode badge while every mode is off, and no goal while no goal runs', () => {
    const row = strip(line2Of({}));
    for (const label of ['计划', '融合', 'RLM', '群狼', '目标']) expect(row).not.toContain(label);
    // No emoji marks either — colour alone carries the mode.
    for (const mark of ['🗒️', '🪐', '🐺']) expect(row).not.toContain(mark);
  });

  it('shows only the modes that are on, in the order plan → RLM → 群狼', () => {
    expect(strip(line2Of({ rlmEnabled: true }))).toContain('RLM');
    expect(strip(line2Of({ rlmEnabled: true }))).not.toContain('计划');
    expect(strip(line2Of({ rlmEnabled: true }))).not.toContain('群狼');
    const all = strip(line2Of({ planMode: 'plan', rlmEnabled: true, wolfpackMode: true }));
    expect(all).toContain('计划  RLM  群狼');
  });

  it('lights a switch with its own colour, in bold, while it is on', () => {
    withTrueColor(() => {
      const row = line2Of({ planMode: 'plan', rlmEnabled: true, wolfpackMode: true });
      expect(row).toContain(`${hexToSgr(darkColors.planMode)}\u001B[1m计划`);
      expect(row).toContain(`${hexToSgr(darkColors.rlmMode)}\u001B[1mRLM`);
      expect(row).toContain(`${hexToSgr(darkColors.wolfpackMode)}\u001B[1m群狼`);
      for (const label of ['计划', 'RLM', '群狼']) {
        expect(row).not.toContain(`${hexToSgr(darkColors.textMuted)}${label}`);
      }
    });
  });

  it('lights fusion plan in the fusion colour', () => {
    withTrueColor(() => {
      const row = line2Of({ planMode: 'fusionplan' });
      expect(row).toContain(`${hexToSgr(darkColors.fusionPlanMode)}\u001B[1m融合`);
      expect(strip(row)).not.toContain('计划');
    });
  });

  it('keeps RLM and 群狼 in place when plan switches between plan and fusion', () => {
    const columns = (overrides: Partial<AppState>): number[] => {
      const row = strip(line2Of({ rlmEnabled: true, wolfpackMode: true, ...overrides }, 120));
      return ['RLM', '群狼'].map((label) => row.indexOf(label));
    };
    const plan = columns({ planMode: 'plan' });
    expect(plan.every((at) => at > 0)).toBe(true);
    expect(columns({ planMode: 'fusionplan' })).toEqual(plan);
  });

  it('shows the goal only while a goal is active, in the primary colour and bold', () => {
    withTrueColor(() => {
      const goal = {
        objective: 'switches',
        status: 'active',
        turnsUsed: 4,
        wallClockMs: 90_000,
        wallClockBaseAt: Date.now(),
        completionCriterion: null,
        tokensUsed: 0,
        inputTokens: null,
        outputTokens: null,
      } as const;
      const on = line2Of({ goalActive: true, goal });
      expect(strip(on)).toContain('目标 1m30s · 4轮');
      expect(on).toContain(`${hexToSgr(darkColors.primary)}\u001B[1m目标`);
      expect(strip(line2Of({ goalActive: false, goal: null }))).not.toContain('目标');
    });
  });
});

describe('FooterComponent — badge order', () => {
  it('separates the identity strip (line 1) from the run strip (line 2)', () => {
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
    // Line 2 opens with the cache hit, then plan → rlm → wolfpack → goal.
    expect(first).not.toContain('群狼');
    expect(first).not.toContain('目标');
    expect(second).toMatch(/^↓ Cache hit:/);
    previous = -1;
    for (const token of ['Cache hit:', '计划', 'RLM', '群狼', '目标']) {
      const at = second!.indexOf(token);
      expect(at, `missing or out of order on line 2: ${token}`).toBeGreaterThan(previous);
      previous = at;
    }
  });
});
