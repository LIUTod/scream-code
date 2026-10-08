/**
 * Regression: the /task full-screen takeover nests two layout-root swaps —
 * the browser replaces the main layout, then the output viewer replaces the
 * browser. Closing the viewer must put the browser back.
 *
 * The bug this pins: `handleOpenOutput` saved `state.layoutRoot` as the
 * restore target, but that field only ever tracks the main layout, so Esc in
 * the viewer rendered the main TUI while focus stayed on the (now unmounted)
 * browser: typing died and a second Esc was needed to really leave /task.
 */
import type { Component, Terminal } from '@liutod-scream/pi-tui';
import type { BackgroundTaskInfo, Session } from '@scream-code/scream-code-sdk';
import { describe, expect, it, vi, type Mock } from 'vitest';

import { TaskOutputViewer } from '@/tui/components/dialogs/task-output-viewer';
import {
  TasksBrowserController,
  type TasksBrowserHost,
  type TasksBrowserState,
} from '@/tui/controllers/tasks-browser';
import { darkColors } from '@/tui/theme/colors';

const ESC = '\u001B';

function fakeTerminal(rows = 30, columns = 120): Terminal {
  return {
    start: () => {},
    stop: () => {},
    drainInput: () => Promise.resolve(),
    write: () => {},
    get columns() {
      return columns;
    },
    get rows() {
      return rows;
    },
    get kittyProtocolActive() {
      return false;
    },
    moveBy: () => {},
    hideCursor: () => {},
    showCursor: () => {},
    clearLine: () => {},
    clearFromCursor: () => {},
    clearScreen: () => {},
    setTitle: () => {},
    setProgress: () => {},
  };
}

/** Stand-in for the main TUI layout (what `state.layoutRoot` points at). */
const MAIN_LAYOUT = {
  render: (): string[] => ['main'],
  invalidate: (): void => {},
} as unknown as Component;
/** Stand-in for the chat editor (the focus target after /task closes). */
const EDITOR = {
  render: (): string[] => ['editor'],
  invalidate: (): void => {},
} as unknown as Component;

function task(overrides: Partial<BackgroundTaskInfo> = {}): BackgroundTaskInfo {
  return {
    taskId: 'bash-aaaaaaaa',
    command: 'npm run dev',
    description: 'dev server',
    status: 'running',
    pid: 1234,
    exitCode: null,
    startedAt: 1,
    endedAt: null,
    ...overrides,
  };
}

function makeHarness(): {
  state: {
    tasksBrowser: TasksBrowserState | undefined;
    ui: { requestRender: Mock; setFocus: Mock; setLayoutRoot: Mock };
  };
  controller: TasksBrowserController;
} {
  const state = {
    tasksBrowser: undefined as TasksBrowserState | undefined,
    theme: { colors: darkColors },
    terminal: fakeTerminal(),
    ui: { requestRender: vi.fn(), setFocus: vi.fn(), setLayoutRoot: vi.fn() },
    layoutRoot: MAIN_LAYOUT,
    editor: EDITOR,
  };
  const session = {
    listBackgroundTasks: vi.fn(async () => [task()]),
    getBackgroundTaskOutput: vi.fn(async () => 'hello\nworld'),
  };
  const host = {
    state,
    backgroundTasks: new Map([[task().taskId, task()]]),
    subagentSlots: [],
    subagentInstances: new Map(),
    recentSubagentInstances: [],
    session: session as unknown as Session,
    showError: vi.fn(),
    setTasksBrowser: vi.fn((value: TasksBrowserState | undefined) => {
      state.tasksBrowser = value;
    }),
  } as unknown as TasksBrowserHost;
  return { state, controller: new TasksBrowserController(host) };
}

describe('TasksBrowserController — viewer/browser layout swaps', () => {
  it('returns to the browser when the viewer closes, and only then leaves /task', async () => {
    const { state, controller } = makeHarness();
    await controller.show();

    try {
      const browser = state.tasksBrowser;
      if (browser === undefined) throw new Error('browser did not open');
      expect(state.ui.setLayoutRoot).toHaveBeenLastCalledWith(browser.component);
      expect(state.ui.setFocus).toHaveBeenLastCalledWith(browser.component);
      // Enter on the selected task opens the full-screen output viewer.
      browser.component.handleInput('\r');
      await Promise.resolve();
      await Promise.resolve();

      const viewer = state.tasksBrowser?.viewer;
      if (viewer === undefined) throw new Error('viewer did not open');
      expect(state.ui.setLayoutRoot).toHaveBeenLastCalledWith(viewer.component);
      expect(state.ui.setFocus).toHaveBeenLastCalledWith(viewer.component);

      // Esc closes the viewer. The browser must be back on screen and focused
      // — restoring the main layout here is the bug: the screen says "main
      // TUI" while every keystroke still lands on the invisible browser.
      viewer.component.handleInput(ESC);
      expect(state.tasksBrowser?.viewer).toBeUndefined();
      expect(state.ui.setLayoutRoot).toHaveBeenLastCalledWith(browser.component);
      expect(state.ui.setFocus).toHaveBeenLastCalledWith(browser.component);

      // The second Esc really leaves /task: main layout, editor focus, no state.
      browser.component.handleInput(ESC);
      expect(state.tasksBrowser).toBeUndefined();
      expect(state.ui.setLayoutRoot).toHaveBeenLastCalledWith(MAIN_LAYOUT);
      expect(state.ui.setFocus).toHaveBeenLastCalledWith(EDITOR);
    } finally {
      // A failing assertion above must not leave the 1s poll intervals alive.
      controller.close();
    }
  });

  it('opens at most one viewer when Enter is pressed twice inside the RPC window', async () => {
    const { state, controller } = makeHarness();
    await controller.show();
    try {
      const browser = state.tasksBrowser;
      if (browser === undefined) throw new Error('browser did not open');

      // Two Enter presses land before the async output fetch resolves: the
      // second one must not create a viewer whose poll interval can never be
      // cleared (only the last viewer is referenced by `browser.viewer`).
      browser.component.handleInput('\r');
      browser.component.handleInput('\r');
      await Promise.resolve();
      await Promise.resolve();

      expect(state.tasksBrowser?.viewer).toBeDefined();
      const viewerRootCalls = state.ui.setLayoutRoot.mock.calls.filter(
        (call: unknown[]) => call[0] instanceof TaskOutputViewer,
      );
      expect(viewerRootCalls).toHaveLength(1);
    } finally {
      controller.close();
    }
  });
});
