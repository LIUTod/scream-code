import { describe, it, expect } from 'vitest';
import { visibleWidth } from '@liutod-scream/pi-tui';

import { FooterComponent } from '#/tui/components/chrome/footer';
import { darkColors } from '#/tui/theme/colors';
import type { AppState } from '#/tui/types';

const ANSI_SGR = /\u001B\[[0-9;]*m/g;
function strip(text: string): string {
  return text.replaceAll(ANSI_SGR, '');
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

/**
 * Build a footer with a long LEFT (all three modes on + goal + model + two running
 * counters) and a long RIGHT (channel + context gauge + idle status), so item
 * fitting has something to chew on. `workDir` stays `/tmp` (not a git repo) so
 * the git badge is absent and the LEFT width is stable.
 */
function wideFooter(): FooterComponent {
  const footer = new FooterComponent(
    baseState({
      planMode: 'plan',
      rlmEnabled: true,
      wolfpackMode: true,
      goalActive: true,
      goal: {
        objective: 'ship footer truncation',
        status: 'active',
        turnsUsed: 7,
        wallClockMs: 3 * 60_000,
        wallClockBaseAt: Date.now(),
        completionCriterion: null,
        tokensUsed: 0,
        inputTokens: null,
        outputTokens: null,
      },
      model: 'scream-k2-5',
      availableModels: {
        'scream-k2-5': { displayName: 'scream-k2-5', model: 'scream-k2-5' } as any,
      },
      contextUsage: 0.5,
      contextTokens: 50_000,
      maxContextTokens: 200_000,
    }),
    darkColors,
    uiMock,
  );
  footer.setBackgroundCounts({ bashTasks: 2, agentTasks: 3, foregroundSubagents: 0 });
  return footer;
}

describe('FooterComponent - item fitting', () => {
  it('fits without truncation at columns=190 (no ellipsis, nothing dropped)', () => {
    const footer = wideFooter();
    const [line1, line2] = footer.render(190);
    expect(visibleWidth(line1!)).toBe(190);
    expect(strip(line1!)).not.toContain('…');
    const row2 = strip(line2!);
    expect(visibleWidth(line2!)).toBe(190);
    expect(row2).not.toContain('…');
    expect(row2.startsWith('↓ 缓存命中: --')).toBe(true);
    // cache hit → plan → rlm → wolfpack → goal → counters → channel
    let previous = -1;
    for (const token of ['缓存命中:', '计划', 'RLM', '群狼', '目标 3m · 7轮', '后台任务 x2 · 后台Agent x3', 'Line: 未连接']) {
      const at = row2.indexOf(token);
      expect(at, `missing or out of order: ${token}`).toBeGreaterThan(previous);
      previous = at;
    }
  });

  it('never overflows at columns=40, and always fills the row', () => {
    const footer = wideFooter();
    for (const line of footer.render(40)) {
      expect(line).toBeDefined();
      expect(visibleWidth(line)).toBe(40);
    }
  });

  it('shrinks the model name — not the gauge — to keep the gauge visible', () => {
    const footer = wideFooter();
    // width 30: the gauge is already down to its bar-less form (17 cols), and
    // the model name (11 cols) is cut to 6 + `…` so both still fit.
    const [line1] = footer.render(30);
    const stripped = strip(line1!);
    expect(visibleWidth(line1!)).toBe(30);
    expect(stripped).toBe('📟️ scream…   📨 Context：50.0%');
  });

  it('drops the gauge when it cannot fit even with the model name fully shrunk', () => {
    // A two-letter model cannot shrink: below name + gap + gauge the gauge goes
    // so the model renders whole.
    const footer = new FooterComponent(
      baseState({
        contextUsage: 0.5,
        contextTokens: 50_000,
        maxContextTokens: 200_000,
      }),
      darkColors,
      uiMock,
    );
    const [line1] = footer.render(17);
    const stripped = strip(line1!);
    expect(visibleWidth(line1!)).toBe(17);
    expect(stripped).not.toContain('Context：');
    expect(stripped).not.toContain('…'); // the model fit whole, no ellipsis needed
    expect(stripped.trimEnd()).toBe('📟️ k2');
  });

  it('cuts a long model name to the narrowest width before giving up its gauge', () => {
    const footer = wideFooter();
    const [line1] = footer.render(10);
    const stripped = strip(line1!);
    expect(visibleWidth(line1!)).toBe(10);
    // Gauge gone, model cut to the 7-column step (`scream…`).
    expect(stripped).not.toContain('Context');
    expect(stripped.trimEnd()).toBe('📟️ scream…');
  });

  it('pads a dropped-gauge row to the full width so the line never wraps', () => {
    const footer = new FooterComponent(
      baseState({
        contextUsage: 0.5,
        contextTokens: 50_000,
        maxContextTokens: 200_000,
      }),
      darkColors,
      uiMock,
    );
    const [line1] = footer.render(20);
    expect(visibleWidth(line1!)).toBe(20);
  });
});

/** A footer with every run-strip item populated, for the line-2 fitting tests. */
function busyFooter(overrides: Partial<AppState> = {}): FooterComponent {
  const footer = new FooterComponent(
    baseState({
      model: 'scream-k2-5',
      planMode: 'plan',
      rlmEnabled: true,
      wolfpackMode: true,
      goalActive: true,
      goal: {
        objective: 'fit',
        status: 'active',
        turnsUsed: 3,
        wallClockMs: 60_000,
        wallClockBaseAt: Date.now(),
        completionCriterion: null,
        tokensUsed: 0,
        inputTokens: null,
        outputTokens: null,
      },
      streamingPhase: 'thinking',
      streamingStartTime: Date.now() - 12_000,
      lineActive: true,
      linePlatform: 'wechat',
      ...overrides,
    }),
    darkColors,
    uiMock,
  );
  footer.setBackgroundCounts({ bashTasks: 2, agentTasks: 1, foregroundSubagents: 3 });
  return footer;
}

function row2(footer: FooterComponent, width: number): string {
  return strip(footer.render(width)[1]!);
}

describe('FooterComponent - line 2 fitting', () => {
  it('never cuts an item in half: no ellipsis, and a counter is whole or absent, at every width', () => {
    const footer = busyFooter();
    for (let width = 24; width <= 200; width++) {
      const row = row2(footer, width);
      expect(visibleWidth(row), `width ${String(width)}`).toBe(width);
      expect(row, `width ${String(width)}`).not.toContain('…');
      for (const word of ['后台任务', '后台Agent', '前台Agent']) {
        if (row.includes(word)) expect(row, `width ${String(width)}`).toMatch(new RegExp(`${word} x\\d`));
      }
    }
    footer.dispose();
  });

  it('only ever adds items as the terminal widens (never fewer at a wider width)', () => {
    const footer = busyFooter();
    const items: [string, RegExp][] = [
      ['cache', /↓/],
      ['plan', /计划/],
      ['rlm', /RLM/],
      ['wolfpack', /群狼/],
      ['goal', /目标/],
      ['counters', /后台任务|运行中/],
      ['channel', /Line/],
      ['status', /思考中/],
    ];
    for (const [name, pattern] of items) {
      let seen = false;
      for (let width = 20; width <= 200; width++) {
        const present = pattern.test(row2(footer, width));
        if (seen) expect(present, `${name} vanished again at width ${String(width)}`).toBe(true);
        seen ||= present;
      }
      expect(seen, `${name} never appeared`).toBe(true);
    }
    footer.dispose();
  });

  it('shortens the cache label before it drops any switch', () => {
    const footer = new FooterComponent(
      baseState({ model: 'scream-k2-5', planMode: 'plan', rlmEnabled: true, wolfpackMode: true }),
      darkColors,
      uiMock,
    );
    let sawFull = false;
    let sawShortWithAllSwitches = false;
    for (let width = 24; width <= 120; width++) {
      const row = row2(footer, width);
      const hasAllSwitches = row.includes('计划') && row.includes('RLM') && row.includes('群狼');
      if (row.includes('缓存命中:')) {
        sawFull = true;
        // The long label only survives while every switch is still shown.
        expect(hasAllSwitches, `width ${String(width)}`).toBe(true);
      }
      if (row.includes('↓ 缓存 ') && hasAllSwitches) sawShortWithAllSwitches = true;
    }
    expect(sawFull).toBe(true);
    // There is a width where the label already gave way but no switch has gone.
    expect(sawShortWithAllSwitches).toBe(true);
    footer.dispose();
  });

  it('keeps the channel on screen at every width where anything fits', () => {
    const footer = busyFooter();
    for (let width = 26; width <= 200; width++) {
      expect(row2(footer, width), `width ${String(width)}`).toContain('Line');
    }
    footer.dispose();
  });

  it('collapses the running counters into one total before dropping them', () => {
    const footer = busyFooter();
    let sawLong = false;
    let sawTotal = false;
    for (let width = 30; width <= 200; width++) {
      const row = row2(footer, width);
      if (row.includes('后台任务 x2 · 后台Agent x1 · 前台Agent x3')) sawLong = true;
      if (row.includes('运行中 6')) {
        sawTotal = true;
        expect(row).not.toContain('后台任务');
      }
    }
    expect(sawLong).toBe(true);
    expect(sawTotal).toBe(true);
    footer.dispose();
  });

  it('collapses the running counters before any switch is dropped', () => {
    const footer = new FooterComponent(
      baseState({ model: 'scream-k2-5', planMode: 'plan', rlmEnabled: true, wolfpackMode: true }),
      darkColors,
      uiMock,
    );
    footer.setBackgroundCounts({ bashTasks: 2, agentTasks: 1, foregroundSubagents: 3 });
    let sawLongWithAllSwitches = false;
    let sawTotalWithAllSwitches = false;
    for (let width = 30; width <= 200; width++) {
      const row = row2(footer, width);
      const hasAllSwitches = row.includes('计划') && row.includes('RLM') && row.includes('群狼');
      // The long form only survives while every switch is still shown.
      if (row.includes('后台任务')) {
        sawLongWithAllSwitches = true;
        expect(hasAllSwitches, `width ${String(width)}`).toBe(true);
      }
      if (row.includes('运行中 6') && hasAllSwitches) sawTotalWithAllSwitches = true;
    }
    expect(sawLongWithAllSwitches).toBe(true);
    // There is a width where the counters already collapsed but no switch has gone.
    expect(sawTotalWithAllSwitches).toBe(true);
    footer.dispose();
  });

  it('shortens the goal readout step by step before dropping it', () => {
    const footer = busyFooter();
    const forms = ['目标 1m · 3轮', '目标 3轮'];
    const seen = new Set<string>();
    let bare = false;
    for (let width = 24; width <= 200; width++) {
      const row = row2(footer, width);
      for (const form of forms) if (row.includes(form)) seen.add(form);
      if (row.includes('目标') && !forms.some((form) => row.includes(form))) bare = true;
    }
    expect([...seen].toSorted()).toEqual([...forms].toSorted());
    expect(bare).toBe(true);
    footer.dispose();
  });

  it('shortens the channel to `Line` before it drops it', () => {
    const footer = busyFooter();
    let sawFull = false;
    let sawShort = false;
    for (let width = 20; width <= 200; width++) {
      const row = row2(footer, width);
      if (row.includes('Line: 微信')) sawFull = true;
      if (row.includes('Line') && !row.includes('Line:')) sawShort = true;
    }
    expect(sawFull).toBe(true);
    expect(sawShort).toBe(true);
    footer.dispose();
  });

  it('sheds the elapsed clock before the work status itself', () => {
    const footer = busyFooter();
    expect(row2(footer, 14)).toContain('思考中 12s');
    // Not a hard cut (`思考中 …`): the status steps down to its clock-free form.
    const narrow = row2(footer, 10);
    expect(narrow).toMatch(/^ *[●◉◎◌○] 思考中$/);
    expect(visibleWidth(narrow)).toBe(10);
    footer.dispose();
  });

  it('keeps a lit mode badge past the counters and goal', () => {
    const footer = busyFooter({ planMode: 'off', wolfpackMode: false, rlmEnabled: true });
    let litAloneSeen = false;
    for (let width = 24; width <= 200; width++) {
      const row = row2(footer, width);
      if (!row.includes('RLM')) {
        // The lit badge is gone: so is everything that ranks below it.
        expect(row, `goal at ${String(width)}`).not.toContain('目标');
        expect(row, `counters at ${String(width)}`).not.toMatch(/后台任务|运行中/);
      } else {
        // Modes that are off never show.
        expect(row, `width ${String(width)}`).not.toMatch(/计划|群狼/);
        litAloneSeen = true;
      }
    }
    expect(litAloneSeen).toBe(true);
    footer.dispose();
  });
});
