import { describe, expect, it, vi } from 'vitest';

import { refreshProviderBalance } from '#/tui/api-balance';
import { ScreamTUI, type ScreamTUIStartupInput, type TUIState } from '#/tui/scream-tui';

vi.mock('#/tui/api-balance', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#/tui/api-balance')>()),
  refreshProviderBalance: vi.fn(),
}));

interface SetAppStateDriver {
  state: TUIState;
  setAppState(patch: Partial<TUIState['appState']>): void;
}

function makeStartupInput(): ScreamTUIStartupInput {
  return {
    cliOptions: {
      session: undefined,
      continue: false,
      yolo: false,
      auto: false,
      plan: false,
      wolfpack: false,
      model: undefined,
      outputFormat: undefined,
      prompt: undefined,
      skillsDirs: [],
    },
    tuiConfig: {
      theme: 'dark',
      language: 'zh',
      editorCommand: null,
      notifications: { enabled: true, condition: 'unfocused' },
      like: {},
      fusionPlan: { timeoutSeconds: 600, workerCount: 3 },
      subagentModels: {},
    },
    version: '0.0.0-test',
    workDir: '/tmp/proj-a',
    resolvedTheme: 'dark',
  };
}

function makeDriver(): SetAppStateDriver {
  const driver = new ScreamTUI(
    { setSubagentModelBindings: () => {}, setModelTierBindings: () => {} } as never,
    makeStartupInput(),
  ) as unknown as SetAppStateDriver;
  vi.spyOn(driver.state.ui, 'requestRender').mockImplementation(() => {});
  vi.spyOn(driver.state.terminal, 'setProgress').mockImplementation(() => {});
  return driver;
}

describe('setAppState sessionUsage reset semantics', () => {
  it('keeps a patch-provided sessionUsage when the session changes (durable HitR seed)', () => {
    const driver = makeDriver();
    driver.setAppState({ sessionId: 'sess-a' });
    const seed = { inputOther: 100, output: 10, inputCacheRead: 900, inputCacheCreation: 0 };

    driver.setAppState({ sessionId: 'sess-b', sessionUsage: seed });

    expect(driver.state.appState.sessionUsage).toEqual(seed);
  });

  it('resets sessionUsage to zero on session switch without a seed', () => {
    const driver = makeDriver();
    driver.setAppState({ sessionId: 'sess-a' });
    driver.setAppState({ sessionId: 'sess-b' });

    expect(driver.state.appState.sessionUsage).toEqual({
      inputOther: 0,
      output: 0,
      inputCacheRead: 0,
      inputCacheCreation: 0,
    });
  });

  it('clears sessionApiCalls on every session switch (it is never seeded)', () => {
    const driver = makeDriver();
    driver.setAppState({ sessionId: 'sess-a' });
    driver.setAppState({ sessionApiCalls: 17 });

    driver.setAppState({ sessionId: 'sess-b' });

    expect(driver.state.appState.sessionApiCalls).toBe(0);
  });
});

describe('setAppState streamingStartTime auto-stamp', () => {
  it('stamps streamingStartTime when transitioning idle → waiting', () => {
    const driver = makeDriver();
    const before = driver.state.appState.streamingStartTime;
    driver.setAppState({ streamingPhase: 'waiting' });

    expect(driver.state.appState.streamingPhase).toBe('waiting');
    expect(driver.state.appState.streamingStartTime).toBeGreaterThan(before);
  });

  it('resets streamingStartTime to 0 when transitioning back to idle', () => {
    const driver = makeDriver();
    driver.setAppState({ streamingPhase: 'waiting' });
    expect(driver.state.appState.streamingStartTime).not.toBe(0);

    driver.setAppState({ streamingPhase: 'idle' });
    expect(driver.state.appState.streamingStartTime).toBe(0);
  });

  it('does not re-stamp when transitioning to the same phase', () => {
    const driver = makeDriver();
    driver.setAppState({ streamingPhase: 'waiting' });
    const stamped = driver.state.appState.streamingStartTime;

    // Sleep briefly so a fresh Date.now() would differ.
    const t0 = Date.now();
    while (Date.now() === t0) { /* spin until clock advances */ }

    driver.setAppState({ streamingPhase: 'waiting' });
    expect(driver.state.appState.streamingStartTime).toBe(stamped);
  });

  it('re-stamps on every distinct phase transition', () => {
    const driver = makeDriver();
    driver.setAppState({ streamingPhase: 'waiting' });
    const waitingStamp = driver.state.appState.streamingStartTime;

    const t0 = Date.now();
    while (Date.now() === t0) { /* spin */ }

    driver.setAppState({ streamingPhase: 'thinking' });
    expect(driver.state.appState.streamingStartTime).toBeGreaterThan(waitingStamp);

    while (Date.now() === driver.state.appState.streamingStartTime) { /* spin */ }

    driver.setAppState({ streamingPhase: 'tool' });
    const toolStamp = driver.state.appState.streamingStartTime;
    expect(toolStamp).toBeGreaterThan(waitingStamp);
  });
});

describe('setAppState provider balance follows the model', () => {
  const balance = { currency: 'CNY', totalBalance: '5.45' };

  it('drops the old balance and looks up the new model when the model changes on any path', () => {
    const driver = makeDriver();
    driver.setAppState({ model: 'deepseek/deepseek-v4-flash', providerBalance: balance });
    vi.mocked(refreshProviderBalance).mockClear();

    // e.g. a login that activates a newly added model sets only `model`.
    driver.setAppState({ model: 'custom-glm-5.4/glm-5.4' });

    expect(driver.state.appState.providerBalance).toBeNull();
    expect(refreshProviderBalance).toHaveBeenCalledTimes(1);
    expect(vi.mocked(refreshProviderBalance).mock.calls[0]![0]).toBe('custom-glm-5.4/glm-5.4');
  });

  it('leaves the balance to a path that handles it itself', () => {
    const driver = makeDriver();
    driver.setAppState({ model: 'deepseek/deepseek-v4-flash', providerBalance: balance });
    vi.mocked(refreshProviderBalance).mockClear();

    driver.setAppState({ model: 'custom-glm-5.4/glm-5.4', providerBalance: null });

    expect(driver.state.appState.providerBalance).toBeNull();
    expect(refreshProviderBalance).not.toHaveBeenCalled();
  });

  it('keeps the balance when the model does not change, and looks nothing up without a model', () => {
    const driver = makeDriver();
    driver.setAppState({ model: 'deepseek/deepseek-v4-flash', providerBalance: balance });
    vi.mocked(refreshProviderBalance).mockClear();

    driver.setAppState({ model: 'deepseek/deepseek-v4-flash', thinkingLevel: 'high' });
    expect(driver.state.appState.providerBalance).toEqual(balance);
    expect(refreshProviderBalance).not.toHaveBeenCalled();

    // Logout clears the model: the balance goes, nothing is looked up.
    driver.setAppState({ model: '' });
    expect(driver.state.appState.providerBalance).toBeNull();
    expect(refreshProviderBalance).not.toHaveBeenCalled();
  });
});
