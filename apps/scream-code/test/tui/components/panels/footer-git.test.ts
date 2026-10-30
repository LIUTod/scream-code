import { describe, it, expect, vi } from 'vitest';
import { visibleWidth } from '@liutod-scream/pi-tui';

import { FooterComponent } from '#/tui/components/chrome/footer';
import { darkColors } from '#/tui/theme/colors';
import type { AppState } from '#/tui/types';

const ANSI = /\u001B\[[0-9;]*m/g;
const strip = (text: string): string => text.replaceAll(ANSI, '');
const uiMock = {
  requestRender: vi.fn(),
} as unknown as ConstructorParameters<typeof FooterComponent>[2];

function baseState(overrides: Partial<AppState> = {}): AppState {
  return {
    model: 'k2',
    workDir: '/repo',
    sessionId: 'sess',
    permissionMode: 'yolo',
    planMode: 'off',
    thinkingLevel: 'off',
    contextUsage: 0.1,
    contextTokens: 1_000,
    maxContextTokens: 200_000,
    isCompacting: false,
    isReplaying: false,
    streamingPhase: 'idle',
    streamingStartTime: 0,
    lineActive: false,
    linePlatform: null,
    providerBalance: null,
    theme: 'dark',
    version: 'test',
    editorCommand: null,
    notifications: { enabled: true, condition: 'unfocused' },
    availableModels: {},
    ...overrides,
  } as AppState;
}

function makeFooter(overrides: Partial<AppState> = {}): FooterComponent {
  return new FooterComponent(baseState(overrides), darkColors, uiMock);
}

describe('FooterComponent — git badge', () => {
  it('closes line 1 with 📁 工作区Git +added-deleted', () => {
    const footer = makeFooter();
    footer.setGitDiffProvider(() => ({ added: 12, deleted: 3 }));

    const line1 = strip(footer.render(120)[0] ?? '');
    expect(line1).toContain('📁 工作区Git +12-3');
    expect(line1.indexOf('k2')).toBeLessThan(line1.indexOf('📁 工作区Git'));
    expect(visibleWidth(line1)).toBe(120);
    footer.dispose();
  });

  it('survives a provider that throws instead of crashing the frame', () => {
    const footer = makeFooter();
    footer.setGitDiffProvider(() => {
      throw new Error('git probe failed');
    });

    const rows = footer.render(120);
    expect(rows).toHaveLength(2);
    for (const line of rows) expect(strip(line)).not.toContain('工作区Git');
    footer.dispose();
  });

  it('hides the badge when the working dir is not a repo', () => {
    const footer = makeFooter();
    footer.setGitDiffProvider(() => null);

    for (const line of footer.render(120)) expect(strip(line)).not.toContain('工作区Git');
    footer.dispose();
  });

  it('stays on line 1 while line 2 keeps the run-state badges, at any width', () => {
    const footer = makeFooter({
      goalActive: true,
      goal: {
        objective: 'footer git',
        status: 'active',
        turnsUsed: 2,
        wallClockMs: 0,
        wallClockBaseAt: Date.now(),
        completionCriterion: null,
        tokensUsed: 0,
        inputTokens: null,
        outputTokens: null,
      },
    });
    footer.setGitDiffProvider(() => ({ added: 5, deleted: 9 }));
    footer.setBackgroundCounts({ bashTasks: 2, agentTasks: 0, foregroundSubagents: 0 });

    const line1 = strip(footer.render(140)[0] ?? '');
    const line2 = strip(footer.render(140)[1] ?? '');
    // The git summary stays on line 1, after the model name.
    expect(line1.indexOf('📁 工作区Git')).toBeGreaterThan(line1.indexOf('k2'));
    // Line 2 opens with the mode badges, then goal, then task badges.
    expect(line2.indexOf('后台任务')).toBeGreaterThan(line2.indexOf('GOAL'));

    const narrow = footer.render(40);
    expect(narrow).toHaveLength(2);
    for (const line of narrow) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
    footer.dispose();
  });
});
