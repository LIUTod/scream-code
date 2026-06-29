import { describe, expect, it } from 'vitest';

import { resolveLoopSubstate } from '#/tui/loop-state';
import type { AppState } from '#/tui/types';

function makeState(overrides: Partial<AppState> = {}): AppState {
  return {
    model: 'test-model',
    workDir: '/tmp',
    sessionId: 'sess-1',
    permissionMode: 'manual',
    planMode: 'off',
    thinkingLevel: 'off',
    contextUsage: 0,
    contextTokens: 0,
    maxContextTokens: 0,
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

describe('resolveLoopSubstate', () => {
  it('returns idle when loop is disabled', () => {
    expect(resolveLoopSubstate(makeState({ loopModeEnabled: false }))).toBe('idle');
  });

  it('returns paused when loop is enabled but prompt is cleared', () => {
    const state = makeState({
      loopModeEnabled: true,
      loopPrompt: undefined,
    });
    expect(resolveLoopSubstate(state)).toBe('paused');
  });

  it('returns running when loop is enabled with a prompt', () => {
    const state = makeState({
      loopModeEnabled: true,
      loopPrompt: 'fix tests',
    });
    expect(resolveLoopSubstate(state)).toBe('running');
  });

  it('returns verifying when loopVerifying is true, even with a prompt', () => {
    const state = makeState({
      loopModeEnabled: true,
      loopPrompt: 'fix tests',
      loopVerifying: true,
    });
    expect(resolveLoopSubstate(state)).toBe('verifying');
  });

  it('returns verifying when loopVerifying is true, even without a prompt', () => {
    // Edge case: verifier running while prompt was just cleared (user
    // pressed Esc mid-verify). The verifying flag is authoritative.
    const state = makeState({
      loopModeEnabled: true,
      loopPrompt: undefined,
      loopVerifying: true,
    });
    expect(resolveLoopSubstate(state)).toBe('verifying');
  });

  it('returns idle when loop is disabled even if loopVerifying is stale', () => {
    // Defensive: loopModeEnabled is the master switch. A stale loopVerifying
    // flag (e.g. after disableLoop) does not resurrect a dead loop.
    const state = makeState({
      loopModeEnabled: false,
      loopVerifying: true,
    });
    expect(resolveLoopSubstate(state)).toBe('idle');
  });
});
