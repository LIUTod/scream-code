import { describe, expect, it } from 'vitest';

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
    workDir: '/tmp/proj',
    sessionId: 'sess_1',
    permissionMode: 'yolo',
    planMode: 'off',
    thinking: false,
    contextUsage: 0,
    contextTokens: 0,
    maxContextTokens: 200_000,
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

// Counter format (global-setup pins locale zh): `后台任务 xN`, `后台Agent xN`,
// `前台Agent xN` — joined by ` · ` in one run, no brackets; collapsed into a
// single `运行中 N` when the row is too short for the long form.
describe('FooterComponent — background task / agent badges', () => {
  it('omits both badges when counts are 0', () => {
    const footer = makeFooter(baseState());
    const line2 = footer.render(160)[1];
    expect(line2).toBeDefined();
    expect(strip(line2!)).not.toMatch(/后台任务 x\d/);
    expect(strip(line2!)).not.toMatch(/后台Agent x\d/);
  });

  it('renders the task badge alone when only bash tasks are running', () => {
    const footer = makeFooter(baseState());
    footer.setBackgroundCounts({ bashTasks: 1, agentTasks: 0, foregroundSubagents: 0 });
    const out = strip(footer.render(160)[1]!);
    expect(out).toContain('后台任务 x1');
    expect(out).not.toMatch(/后台Agent x\d/);
  });

  it('renders the agent badge alone when only agent tasks are running', () => {
    const footer = makeFooter(baseState());
    footer.setBackgroundCounts({ bashTasks: 0, agentTasks: 1, foregroundSubagents: 0 });
    const out = strip(footer.render(160)[1]!);
    expect(out).toContain('后台Agent x1');
    expect(out).not.toMatch(/后台任务 x\d/);
  });

  it('renders both badges side by side when both are non-zero', () => {
    const footer = makeFooter(baseState());
    footer.setBackgroundCounts({ bashTasks: 2, agentTasks: 3, foregroundSubagents: 0 });
    const out = strip(footer.render(160)[1]!);
    expect(out).toContain('后台任务 x2');
    expect(out).toContain('后台Agent x3');
    // Task badge appears before agent badge in the line.
    expect(out.indexOf('后台任务 x2')).toBeLessThan(out.indexOf('后台Agent x3'));
  });

  it('renders both badges with the same xN suffix pattern (unified format)', () => {
    const footer = makeFooter(baseState());
    footer.setBackgroundCounts({ bashTasks: 1, agentTasks: 1, foregroundSubagents: 0 });
    const out = strip(footer.render(160)[1]!);
    expect(out).toContain('后台任务 x1');
    expect(out).toContain('后台Agent x1');
  });

  it('updates badges live via setBackgroundCounts', () => {
    const footer = makeFooter(baseState());
    footer.setBackgroundCounts({ bashTasks: 2, agentTasks: 1, foregroundSubagents: 1 });
    expect(strip(footer.render(160)[1]!)).toContain('后台任务 x2');
    footer.setBackgroundCounts({ bashTasks: 0, agentTasks: 0, foregroundSubagents: 0 });
    const after = strip(footer.render(160)[1]!);
    expect(after).not.toMatch(/后台任务 x\d/);
    expect(after).not.toMatch(/后台Agent x\d/);
    expect(after).not.toMatch(/前台Agent x\d/);
  });

  it('clamps negative counts to 0', () => {
    const footer = makeFooter(baseState());
    footer.setBackgroundCounts({ bashTasks: -5, agentTasks: -2, foregroundSubagents: -3 });
    const out = strip(footer.render(160)[1]!);
    expect(out).not.toMatch(/后台任务 x\d/);
    expect(out).not.toMatch(/后台Agent x\d/);
    expect(out).not.toMatch(/前台Agent x\d/);
  });

  it('drops the badges when terminal is too narrow to fit them', () => {
    const footer = makeFooter(baseState());
    footer.setBackgroundCounts({ bashTasks: 4, agentTasks: 3, foregroundSubagents: 2 });
    // Extremely narrow width: the channel and work status win the row, so the
    // counters are dropped whole — never left as a half-cut fragment.
    const rows = strip(footer.render(20).join(''));
    expect(rows).not.toContain('后台任务');
    expect(rows).not.toContain('后台Agent');
    expect(rows).not.toContain('前台Agent');
    expect(rows).not.toContain('运行中');
  });

  it('joins the counters with · and no brackets', () => {
    const footer = makeFooter(baseState());
    footer.setBackgroundCounts({ bashTasks: 2, agentTasks: 3, foregroundSubagents: 1 });
    const out = strip(footer.render(200)[1]!);
    expect(out).toContain('后台任务 x2 · 后台Agent x3 · 前台Agent x1');
    expect(out).not.toContain('[');
  });

  it('collapses the three counters into one running total when the row is short', () => {
    const footer = makeFooter(baseState());
    footer.setBackgroundCounts({ bashTasks: 2, agentTasks: 3, foregroundSubagents: 1 });
    let collapsed = false;
    for (let width = 30; width <= 200; width++) {
      const out = strip(footer.render(width)[1]!);
      if (out.includes('运行中 6')) {
        collapsed = true;
        expect(out).not.toContain('后台任务');
      }
    }
    expect(collapsed).toBe(true);
  });

  it('the total counts every kind, including a single one', () => {
    const footer = makeFooter(baseState());
    footer.setBackgroundCounts({ bashTasks: 0, agentTasks: 0, foregroundSubagents: 4 });
    let total = false;
    for (let width = 30; width <= 200; width++) {
      if (strip(footer.render(width)[1]!).includes('运行中 4')) total = true;
    }
    expect(total).toBe(true);
  });

  it('renders the foreground subagents badge alone (P1)', () => {
    const footer = makeFooter(baseState());
    footer.setBackgroundCounts({ bashTasks: 0, agentTasks: 0, foregroundSubagents: 2 });
    const out = strip(footer.render(160)[1]!);
    expect(out).toContain('前台Agent x2');
    expect(out).not.toMatch(/后台任务 x\d/);
    expect(out).not.toMatch(/后台Agent x\d/);
  });

  it('omits the subagents badge when 0 (no collaboration → no badge)', () => {
    const footer = makeFooter(baseState());
    footer.setBackgroundCounts({ bashTasks: 0, agentTasks: 0, foregroundSubagents: 0 });
    const out = strip(footer.render(160)[1]!);
    expect(out).not.toMatch(/前台Agent x\d/);
  });

  it('renders subagents badge alongside background agents (P1 coexistence)', () => {
    const footer = makeFooter(baseState());
    footer.setBackgroundCounts({ bashTasks: 1, agentTasks: 1, foregroundSubagents: 3 });
    const out = strip(footer.render(160)[1]!);
    expect(out).toContain('后台任务 x1');
    expect(out).toContain('后台Agent x1');
    expect(out).toContain('前台Agent x3');
  });
});
