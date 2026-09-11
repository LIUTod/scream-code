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
    permissionMode: 'manual',
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

// Unified badge format (global-setup pins locale zh):
//   [后台任务 xN] / [后台Agent xN] / [前台Agent xN]
describe('FooterComponent — background task / agent badges', () => {
  it('omits both badges when counts are 0', () => {
    const footer = makeFooter(baseState());
    const [line1] = footer.render(160);
    expect(line1).toBeDefined();
    expect(strip(line1!)).not.toMatch(/后台任务 x\d/);
    expect(strip(line1!)).not.toMatch(/后台Agent x\d/);
  });

  it('renders the task badge alone when only bash tasks are running', () => {
    const footer = makeFooter(baseState());
    footer.setBackgroundCounts({ bashTasks: 1, agentTasks: 0, foregroundSubagents: 0 });
    const out = strip(footer.render(160)[0]!);
    expect(out).toMatch(/\[后台任务 x1\]/);
    expect(out).not.toMatch(/后台Agent x\d/);
  });

  it('renders the agent badge alone when only agent tasks are running', () => {
    const footer = makeFooter(baseState());
    footer.setBackgroundCounts({ bashTasks: 0, agentTasks: 1, foregroundSubagents: 0 });
    const out = strip(footer.render(160)[0]!);
    expect(out).toMatch(/\[后台Agent x1\]/);
    expect(out).not.toMatch(/后台任务 x\d/);
  });

  it('renders both badges side by side when both are non-zero', () => {
    const footer = makeFooter(baseState());
    footer.setBackgroundCounts({ bashTasks: 2, agentTasks: 3, foregroundSubagents: 0 });
    const out = strip(footer.render(160)[0]!);
    expect(out).toMatch(/\[后台任务 x2\]/);
    expect(out).toMatch(/\[后台Agent x3\]/);
    // Task badge appears before agent badge in the line.
    expect(out.indexOf('后台任务 x2')).toBeLessThan(out.indexOf('后台Agent x3'));
  });

  it('renders both badges with the same xN suffix pattern (unified format)', () => {
    const footer = makeFooter(baseState());
    footer.setBackgroundCounts({ bashTasks: 1, agentTasks: 1, foregroundSubagents: 0 });
    const out = strip(footer.render(160)[0]!);
    expect(out).toMatch(/\[后台任务 x1\]/);
    expect(out).toMatch(/\[后台Agent x1\]/);
  });

  it('updates badges live via setBackgroundCounts', () => {
    const footer = makeFooter(baseState());
    footer.setBackgroundCounts({ bashTasks: 2, agentTasks: 1, foregroundSubagents: 1 });
    expect(strip(footer.render(160)[0]!)).toMatch(/\[后台任务 x2\]/);
    footer.setBackgroundCounts({ bashTasks: 0, agentTasks: 0, foregroundSubagents: 0 });
    const after = strip(footer.render(160)[0]!);
    expect(after).not.toMatch(/后台任务 x\d/);
    expect(after).not.toMatch(/后台Agent x\d/);
    expect(after).not.toMatch(/前台Agent x\d/);
  });

  it('clamps negative counts to 0', () => {
    const footer = makeFooter(baseState());
    footer.setBackgroundCounts({ bashTasks: -5, agentTasks: -2, foregroundSubagents: -3 });
    const out = strip(footer.render(160)[0]!);
    expect(out).not.toMatch(/后台任务 x\d/);
    expect(out).not.toMatch(/后台Agent x\d/);
    expect(out).not.toMatch(/前台Agent x\d/);
  });

  it('drops the badges when terminal is too narrow to fit them', () => {
    const footer = makeFooter(baseState());
    footer.setBackgroundCounts({ bashTasks: 4, agentTasks: 3, foregroundSubagents: 2 });
    // Extremely narrow width: footer primary content fills the line, so leftLine wins.
    const [line1] = footer.render(20);
    expect(line1).toBeDefined();
    expect(strip(line1!)).not.toMatch(/\[后台任务 x4\]/);
    expect(strip(line1!)).not.toMatch(/\[后台Agent x3\]/);
  });

  it('renders the foreground subagents badge alone (P1)', () => {
    const footer = makeFooter(baseState());
    footer.setBackgroundCounts({ bashTasks: 0, agentTasks: 0, foregroundSubagents: 2 });
    const out = strip(footer.render(160)[0]!);
    expect(out).toMatch(/\[前台Agent x2\]/);
    expect(out).not.toMatch(/后台任务 x\d/);
    expect(out).not.toMatch(/后台Agent x\d/);
  });

  it('omits the subagents badge when 0 (no collaboration → no badge)', () => {
    const footer = makeFooter(baseState());
    footer.setBackgroundCounts({ bashTasks: 0, agentTasks: 0, foregroundSubagents: 0 });
    const out = strip(footer.render(160)[0]!);
    expect(out).not.toMatch(/前台Agent x\d/);
  });

  it('renders subagents badge alongside background agents (P1 coexistence)', () => {
    const footer = makeFooter(baseState());
    footer.setBackgroundCounts({ bashTasks: 1, agentTasks: 1, foregroundSubagents: 3 });
    const out = strip(footer.render(160)[0]!);
    expect(out).toMatch(/\[后台任务 x1\]/);
    expect(out).toMatch(/\[后台Agent x1\]/);
    expect(out).toMatch(/\[前台Agent x3\]/);
  });
});
