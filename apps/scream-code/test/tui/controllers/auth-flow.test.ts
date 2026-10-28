import { describe, expect, it, vi } from 'vitest';

import { AuthFlowController, type AuthFlowHost } from '#/tui/controllers/auth-flow';

import { createMockTUIState } from '../fixtures/mock-host';

function makeHost(
  options: {
    withSession?: boolean;
    config?: { providers: Record<string, unknown>; models: Record<string, unknown> };
  } = {},
): { host: AuthFlowHost; state: ReturnType<typeof createMockTUIState>; controller: AuthFlowController } {
  const state = createMockTUIState({
    appState: {
      model: 'alias-a',
      sessionId: 'ses-live',
      sessionTitle: 'Live conversation',
      thinkingLevel: 'high',
      contextTokens: 1234,
      contextUsage: 0.25,
      maxContextTokens: 200_000,
    },
  });
  const session = options.withSession === false ? undefined : ({ id: 'ses-live' } as never);
  const host = {
    state,
    session,
    harness: {
      getConfig: vi.fn(async () => options.config ?? { providers: {}, models: {} }),
    },
    options: { startup: {} },
    setAppState: vi.fn((patch: Record<string, unknown>) => {
      Object.assign(state.appState, patch);
    }),
    setStartupReady: vi.fn(),
    resetSessionRuntime: vi.fn(),
    setSession: vi.fn(async () => {}),
    syncRuntimeState: vi.fn(async () => {}),
    closeSession: vi.fn(async () => {}),
    appendStartupNotice: vi.fn(),
    sessionEventHandler: {},
    fetchSessions: vi.fn(async () => {}),
    refreshSessionTitle: vi.fn(),
    refreshSkillCommands: vi.fn(async () => {}),
  } as unknown as AuthFlowHost;

  return { host, state, controller: new AuthFlowController(host) };
}

describe('AuthFlowController.detachModelAfterLogout', () => {
  it('解绑模型但保留会话：不关闭会话、不重置运行时、不清会话标识', async () => {
    const { host, state, controller } = makeHost();

    await controller.detachModelAfterLogout();

    expect(state.appState.model).toBe('');
    expect(state.appState.detachedModel).toBe('alias-a');
    expect(state.appState.sessionId).toBe('ses-live');
    expect(state.appState.sessionTitle).toBe('Live conversation');
    expect(host.closeSession).not.toHaveBeenCalled();
    expect(host.resetSessionRuntime).not.toHaveBeenCalled();
    expect(host.refreshSkillCommands).toHaveBeenCalledWith(host.session);
  });

  it('无会话时同样安全（只清模型）', async () => {
    const { host, state, controller } = makeHost({ withSession: false });

    await controller.detachModelAfterLogout();

    expect(state.appState.model).toBe('');
    expect(host.closeSession).not.toHaveBeenCalled();
    expect(host.refreshSkillCommands).toHaveBeenCalledWith(undefined);
  });
});

describe('AuthFlowController.refreshConfigAfterLogout', () => {
  it('刷新可用的服务商/模型，但保留会话级 token 统计', async () => {
    const { state, controller } = makeHost({
      config: { providers: { p1: { baseUrl: 'https://example.test' } }, models: { m1: { provider: 'p1' } } },
    });

    await controller.refreshConfigAfterLogout();

    expect(state.appState.model).toBe('');
    expect(state.appState.availableProviders).toEqual({ p1: { baseUrl: 'https://example.test' } });
    expect(state.appState.availableModels).toEqual({ m1: { provider: 'p1' } });
    // 会话仍在，上下文统计必须保留，否则状态栏会谎报“上下文为空”。
    expect(state.appState.contextTokens).toBe(1234);
    expect(state.appState.contextUsage).toBe(0.25);
    expect(state.appState.maxContextTokens).toBe(200_000);
  });
});
