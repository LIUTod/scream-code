import { describe, expect, it, vi } from 'vitest';

import { ScreamTUI, type ScreamTUIStartupInput, type TUIState } from '#/tui/scream-tui';

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
      model: undefined,
      outputFormat: undefined,
      prompt: undefined,
      skillsDirs: [],
    },
    tuiConfig: {
      theme: 'dark',
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
  const driver = new ScreamTUI({ setSubagentModelBindings: () => {} } as never, makeStartupInput()) as unknown as SetAppStateDriver;
  vi.spyOn(driver.state.ui, 'requestRender').mockImplementation(() => {});
  vi.spyOn(driver.state.terminal, 'setProgress').mockImplementation(() => {});
  return driver;
}

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
