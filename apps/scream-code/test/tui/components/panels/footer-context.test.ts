import { describe, it, expect } from 'vitest';
import chalk from 'chalk';

import { FooterComponent, formatFooterGitBadge, buildWeightedTips } from '#/tui/components/chrome/footer';
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
    planMode: false,
    thinking: false,
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
    expect(out).toMatch(/上下文：0\.0%/);
  });

  it('undefined-ish (coerced) usage → renders 0.0%', () => {
    const fc = makeFooter(
      baseState({ contextUsage: undefined as unknown as number }),
    );
    const out = strip(fc.render(120).join(''));
    expect(out).not.toMatch(/NaN/);
    expect(out).toMatch(/上下文：0\.0%/);
  });

  it('clamps ratios above 1.0 → renders 100.0%', () => {
    const fc = makeFooter(baseState({ contextUsage: 1.5 }));
    const out = strip(fc.render(120).join(''));
    expect(out).toMatch(/上下文：100\.0%/);
  });

  it('ratio 0.427 → renders 42.7%', () => {
    const fc = makeFooter(baseState({ contextUsage: 0.427 }));
    const out = strip(fc.render(200).join(''));
    expect(out).toMatch(/上下文：42\.7%/);
  });

  it('tokens provided but max=0 → falls back to percent-only, no division-by-zero artefact', () => {
    const fc = makeFooter(
      baseState({ contextUsage: 0, contextTokens: 500, maxContextTokens: 0 }),
    );
    const out = strip(fc.render(200).join(''));
    expect(out).not.toMatch(/Infinity|NaN/);
    expect(out).toMatch(/上下文：0\.0%/);
    // With maxTokens=0, token-count annotation is suppressed.
    expect(out).not.toMatch(/\(500\//);
  });

  it('setState updates visible model and context values', () => {
    const footer = makeFooter(baseState({ model: 'k2', contextUsage: 0 }));

    footer.setState(baseState({ model: 'scream-k2-5', contextUsage: 0.5 }));

    const out = strip(footer.render(200).join(''));
    expect(out).toContain('scream-k2-5');
    expect(out).not.toContain(' k2 ');
    expect(out).toMatch(/上下文：50\.0%/);
  });

  it('does not show a thinking label in the footer', () => {
    const on = makeFooter(baseState({ model: 'k2', thinking: true }));

    expect(strip(on.render(120)[0]!)).not.toContain('思考中');
  });

  it('renders transient hints replacing the status area', () => {
    const footer = makeFooter(baseState());

    footer.setTransientHint('Press Ctrl-C again to exit');

    const [line1] = footer.render(120);
    expect(strip(line1 ?? '')).toContain('Press Ctrl-C again to exit');
  });

  it('renders status info on line 1 when no hint', () => {
    const footer = makeFooter(baseState());

    const [line1] = footer.render(120);
    expect(strip(line1 ?? '')).toContain('上下文：0.0%');
  });

  it('highlights the pull request badge separately from git status text', () => {
    const previousLevel = chalk.level;
    chalk.level = 3;
    try {
      const out = formatFooterGitBadge(
        {
          branch: 'feature/footer',
          dirty: false,
          ahead: 0,
          behind: 0,
          diffAdded: 0,
          diffDeleted: 0,
          pullRequest: {
            number: 6,
            url: 'https://github.com/acme/repo/pull/6',
          },
        },
        darkColors,
      );

      const primaryIndex = out.indexOf(hexToSgr(darkColors.primary));
      const statusIndex = out.indexOf(hexToSgr(darkColors.status));
      const badgeIndex = out.indexOf('[PR#6]');
      expect(statusIndex).toBeGreaterThanOrEqual(0);
      expect(primaryIndex).toBeGreaterThanOrEqual(0);
      expect(primaryIndex).toBeLessThan(badgeIndex);
      expect(strip(out)).toContain('feature/footer ');
      expect(strip(out)).toContain('[PR#6]');
    } finally {
      chalk.level = previousLevel;
    }
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

describe('buildWeightedTips — weighted rotation', () => {
  it('repeats higher-priority tips more often (length = sum of weights)', () => {
    const seq = buildWeightedTips([
      { text: 'a' }, // weight 1 (default)
      { text: 'b', priority: 3 },
      { text: 'c', priority: 2 },
    ]);

    const count = (t: string) => seq.filter((x) => x.text === t).length;
    expect(seq).toHaveLength(6);
    expect(count('a')).toBe(1);
    expect(count('b')).toBe(3);
    expect(count('c')).toBe(2);
    expect(count('b')).toBeGreaterThan(count('a'));
  });

  it('keeps duplicates spread out — no tip sits next to itself', () => {
    const seq = buildWeightedTips([
      { text: 'a' },
      { text: 'b', priority: 3 },
      { text: 'c', priority: 2 },
    ]);

    for (let i = 1; i < seq.length; i++) {
      expect(seq[i]!.text).not.toBe(seq[i - 1]!.text);
    }
  });

  it('preserves array order when all weights are the default (1)', () => {
    const seq = buildWeightedTips([{ text: 'x' }, { text: 'y' }, { text: 'z' }]);
    expect(seq.map((t) => t.text)).toEqual(['x', 'y', 'z']);
  });

  it('clamps non-positive / fractional priorities to a weight of at least 1', () => {
    const seq = buildWeightedTips([
      { text: 'a', priority: 0 },
      { text: 'b', priority: -5 },
      { text: 'c', priority: 1.9 },
    ]);
    expect(seq).toHaveLength(3);
    expect(seq.map((t) => t.text).toSorted()).toEqual(['a', 'b', 'c']);
  });
});
