import { t } from '@scream-code/config';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { handleLogoutCommand } from '#/tui/commands/auth';

import { makeMockHarness, makeMockSlashCommandHost } from '../fixtures/mock-host';

const promptLogoutProviderSelection = vi.fn();

vi.mock('../../../src/tui/commands/prompts.js', () => ({
  promptLogoutProviderSelection: (...args: unknown[]) => promptLogoutProviderSelection(...args),
}));

const PROVIDERS = {
  p1: { baseUrl: 'https://p1.example.test' },
  p2: { baseUrl: 'https://p2.example.test' },
};

function makeHost(options: { streaming?: boolean } = {}) {
  const removeProvider = vi.fn(async () => ({ providers: PROVIDERS, models: {} }));
  const harness = makeMockHarness({
    getConfig: vi.fn(async () => ({
      providers: PROVIDERS,
      models: { 'model-a': { provider: 'p1' }, 'model-b': { provider: 'p2' } },
    })),
    removeProvider,
  });

  const base = makeMockSlashCommandHost({
    harness,
    appState: {
      model: 'model-a',
      availableModels: { 'model-a': { provider: 'p1' }, 'model-b': { provider: 'p2' } },
      availableProviders: PROVIDERS,
      ...(options.streaming === true ? { streamingPhase: 'composing' } : {}),
    } as never,
  });

  const authFlow = {
    refreshConfigAfterLogout: vi.fn(async () => {}),
    detachModelAfterLogout: vi.fn(async () => {}),
    refreshConfigAfterLogin: vi.fn(async () => {}),
  };

  const host = Object.assign(base, { authFlow });
  return { host, harness, authFlow, removeProvider };
}

describe('handleLogoutCommand', () => {
  beforeEach(() => {
    promptLogoutProviderSelection.mockReset();
  });

  it('删除当前服务商：解绑模型但保留会话（不关闭、不新建）', async () => {
    promptLogoutProviderSelection.mockResolvedValue('p1');
    const { host, harness, authFlow, removeProvider } = makeHost();

    await handleLogoutCommand(host);

    expect(removeProvider).toHaveBeenCalledWith('p1');
    expect(authFlow.refreshConfigAfterLogout).toHaveBeenCalledOnce();
    expect(authFlow.detachModelAfterLogout).toHaveBeenCalledOnce();
    expect(host.showStatus).toHaveBeenCalledWith(t('auth.deleted_current', { name: 'p1' }));
    // 会话未被关闭，也没有另开新会话。
    expect(harness.createSession).not.toHaveBeenCalled();
  });

  it('删除非当前服务商：只刷新可用列表，不动会话与模型', async () => {
    promptLogoutProviderSelection.mockResolvedValue('p2');
    const { host, harness, authFlow, removeProvider } = makeHost();

    await handleLogoutCommand(host);

    expect(removeProvider).toHaveBeenCalledWith('p2');
    expect(authFlow.refreshConfigAfterLogout).not.toHaveBeenCalled();
    expect(authFlow.detachModelAfterLogout).not.toHaveBeenCalled();
    expect(host.state.appState.model).toBe('model-a');
    expect(host.showStatus).toHaveBeenCalledWith(t('auth.deleted', { name: 'p2' }));
  });

  it('任务进行中拒绝删除', async () => {
    promptLogoutProviderSelection.mockResolvedValue('p1');
    const { host, removeProvider, authFlow } = makeHost({ streaming: true });

    await handleLogoutCommand(host);

    expect(host.showError).toHaveBeenCalledWith(t('auth.logout_busy'));
    expect(removeProvider).not.toHaveBeenCalled();
    expect(authFlow.detachModelAfterLogout).not.toHaveBeenCalled();
  });

  it('用户取消选择时不做任何改动', async () => {
    promptLogoutProviderSelection.mockResolvedValue(undefined);
    const { host, removeProvider, authFlow } = makeHost();

    await handleLogoutCommand(host);

    expect(removeProvider).not.toHaveBeenCalled();
    expect(authFlow.detachModelAfterLogout).not.toHaveBeenCalled();
    expect(host.showStatus).not.toHaveBeenCalled();
  });
});
