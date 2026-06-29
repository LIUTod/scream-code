import { describe, expect, it, vi } from 'vitest';

import { handleLoopCommand, describeLoopStatus } from '#/tui/commands/loop';
import type { SlashCommandHost } from '#/tui/commands/dispatch';
import type { AppState } from '#/tui/types';
import type { TUIState } from '#/tui/tui-state';
import { darkColors } from '#/tui/theme/colors';

function makeAppState(overrides: Partial<AppState> = {}): AppState {
  return {
    model: 'test-model',
    workDir: '/tmp',
    sessionId: 'test-session',
    permissionMode: 'manual',
    planMode: 'off',
    thinkingLevel: 'off',
    contextUsage: 0,
    contextTokens: 0,
    maxContextTokens: 1000,
    isCompacting: false,
    lastCompactionFinishedAt: undefined,
    autoCompactionCount: 0,
    isReplaying: false,
    streamingPhase: 'idle',
    streamingStartTime: 0,
    theme: 'dark',
    version: '0.0.0-test',
    hasNewVersion: false,
    latestVersion: null,
    editorCommand: null,
    notifications: { enabled: true, condition: 'unfocused' },
    like: {},
    fusionPlan: { timeoutSeconds: 600, workerCount: 3 },
    subagentModels: {},
    availableModels: {},
    availableProviders: {},
    sessionTitle: null,
    goal: null,
    goalActive: false,
    goalContinuationCount: 0,
    ccConnectActive: false,
    wolfpackMode: false,
    loopModeEnabled: false,
    loopPrompt: undefined,
    loopLimit: undefined,
    loopVerifier: undefined,
    loopIteration: 0,
    loopLastVerifyPassed: undefined,
    loopVerifying: false,
    recentSessions: [],
    subagentUsage: {},
    ...overrides,
  };
}

function makeHost(overrides: { appState?: Partial<AppState>; session?: unknown } = {}): SlashCommandHost {
  const appState = makeAppState(overrides.appState ?? {});
  const host: Record<string, unknown> = {
    session: 'test-session',
    state: {
      appState,
      theme: { colors: darkColors },
      ui: { requestRender: vi.fn() },
    } as unknown as TUIState,
    setAppState: vi.fn((patch: Partial<AppState>) => {
      Object.assign(appState, patch);
    }),
    showError: vi.fn(),
    showStatus: vi.fn(),
    showNotice: vi.fn(),
    sendNormalUserInput: vi.fn(),
  };
  if ('session' in overrides) {
    host['session'] = overrides.session;
  }
  return host as unknown as SlashCommandHost;
}

describe('handleLoopCommand', () => {
  it('shows help when disabled and no args', async () => {
    const host = makeHost();
    await handleLoopCommand(host, '');
    expect(host.showNotice).toHaveBeenCalledWith('/loop 循环模式', expect.any(String));
    expect(host.setAppState).not.toHaveBeenCalled();
  });

  it('disables loop when enabled and no args', async () => {
    const host = makeHost({ appState: { loopModeEnabled: true, loopPrompt: 'fix' } });
    await handleLoopCommand(host, '');
    expect(host.setAppState).toHaveBeenCalledWith({
      loopModeEnabled: false,
      loopPrompt: undefined,
      loopLimit: undefined,
      loopVerifier: undefined,
      loopIteration: 0,
      loopLastVerifyPassed: undefined,
      loopVerifying: false,
    });
    expect(host.showStatus).toHaveBeenCalledWith('循环模式已关闭。');
  });

  it('shows error when model is not set', async () => {
    const host = makeHost({ appState: { model: '' } });
    await handleLoopCommand(host, '10 fix');
    expect(host.showError).toHaveBeenCalled();
    expect(host.setAppState).not.toHaveBeenCalled();
  });

  it('shows error when session is missing', async () => {
    const host = makeHost({ session: undefined });
    await handleLoopCommand(host, '10 fix');
    expect(host.showError).toHaveBeenCalled();
    expect(host.setAppState).not.toHaveBeenCalled();
  });

  it('enables loop with limit and inline prompt', async () => {
    const host = makeHost();
    await handleLoopCommand(host, '3 fix tests');
    expect(host.setAppState).toHaveBeenCalledWith({
      loopModeEnabled: true,
      loopPrompt: undefined,
      loopLimit: expect.objectContaining({ kind: 'iterations', initial: 3, remaining: 3 }),
      loopVerifier: undefined,
      loopIteration: 0,
      loopLastVerifyPassed: undefined,
      loopVerifying: false,
    });
    expect(host.showNotice).toHaveBeenCalledWith('循环模式已开启', expect.stringContaining('剩余 3/3 次'));
    expect(host.sendNormalUserInput).toHaveBeenCalledWith('fix tests');
  });

  it('resumes paused loop with a new prompt', async () => {
    const host = makeHost({
      appState: { loopModeEnabled: true, loopPrompt: undefined, loopLimit: { kind: 'iterations', initial: 5, remaining: 3 } },
    });
    await handleLoopCommand(host, 'continue fixing');
    expect(host.setAppState).toHaveBeenCalledWith({
      loopLimit: { kind: 'iterations', initial: 5, remaining: 3 },
      loopPrompt: 'continue fixing',
      loopVerifier: undefined,
    });
    expect(host.sendNormalUserInput).toHaveBeenCalledWith('continue fixing');
  });

  it('updates prompt without sending when loop is already running', async () => {
    const host = makeHost({
      appState: { loopModeEnabled: true, loopPrompt: 'old prompt', loopLimit: { kind: 'iterations', initial: 5, remaining: 3 } },
    });
    await handleLoopCommand(host, 'new prompt');
    expect(host.setAppState).toHaveBeenCalledWith({
      loopLimit: { kind: 'iterations', initial: 5, remaining: 3 },
      loopPrompt: 'new prompt',
      loopVerifier: undefined,
    });
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith('循环提示词已更新。');
  });

  it('resets limit when a new limit is provided while enabled', async () => {
    const host = makeHost({
      appState: { loopModeEnabled: true, loopPrompt: 'old', loopLimit: { kind: 'iterations', initial: 5, remaining: 3 } },
    });
    await handleLoopCommand(host, '10 new prompt');
    expect(host.setAppState).toHaveBeenCalledWith({
      loopLimit: expect.objectContaining({ kind: 'iterations', initial: 10, remaining: 10 }),
      loopPrompt: 'new prompt',
      loopVerifier: undefined,
    });
  });
});

describe('describeLoopStatus', () => {
  it('describes disabled loop', () => {
    expect(describeLoopStatus(false, undefined, undefined)).toBe('循环：关闭');
  });

  it('describes enabled loop with iteration limit', () => {
    expect(describeLoopStatus(true, undefined, { kind: 'iterations', initial: 5, remaining: 3 })).toBe(
      '循环：开启（剩余 3/5 次）',
    );
  });

  it('describes enabled loop waiting for prompt', () => {
    expect(describeLoopStatus(true, undefined, undefined)).toBe('循环：开启（等待下一条提示词）');
  });
});
