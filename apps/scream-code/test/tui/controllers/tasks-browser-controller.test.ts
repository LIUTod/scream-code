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

function makeHarness(options: {
  fetched?: BackgroundTaskInfo[];
  subagentOwned?: readonly [BackgroundTaskInfo, string][];
  subagentType?: string;
} = {}): {
  state: {
    tasksBrowser: TasksBrowserState | undefined;
    ui: { requestRender: Mock; setFocus: Mock; setLayoutRoot: Mock };
  };
  controller: TasksBrowserController;
  session: {
    listBackgroundTasks: Mock;
    getBackgroundTaskOutput: Mock;
    stopBackgroundTask: Mock;
  };
} {
  const state = {
    tasksBrowser: undefined as TasksBrowserState | undefined,
    theme: { colors: darkColors },
    terminal: fakeTerminal(),
    ui: { requestRender: vi.fn(), setFocus: vi.fn(), setLayoutRoot: vi.fn() },
    layoutRoot: MAIN_LAYOUT,
    editor: EDITOR,
  };
  const fetched = options.fetched ?? [task()];
  const owned = options.subagentOwned ?? [];
  const allTasks = [...fetched, ...owned.map(([info]) => info)];
  const session = {
    listBackgroundTasks: vi.fn(async () => fetched),
    getBackgroundTaskOutput: vi.fn(async () => 'hello\nworld'),
    stopBackgroundTask: vi.fn(async () => {}),
  };
  const host = {
    state,
    backgroundTasks: new Map(allTasks.map((info) => [info.taskId, info] as const)),
    backgroundTaskOwners: new Map(owned.map(([info, owner]) => [info.taskId, owner] as const)),
    subagentSlots: [],
    subagentInstances: new Map(
      owned.map(([, owner]) => [
        owner,
        {
          agentId: owner,
          type: options.subagentType ?? 'coder',
          description: undefined,
          parentAgentId: undefined,
          parentToolCallId: `call_${owner}`,
          parentToolName: undefined,
          parentToolDescription: undefined,
          spawnedAt: 1,
        },
      ]),
    ),
    recentSubagentInstances: [],
    session: session as unknown as Session,
    showError: vi.fn(),
    setTasksBrowser: vi.fn((value: TasksBrowserState | undefined) => {
      state.tasksBrowser = value;
    }),
  } as unknown as TasksBrowserHost;
  return { state, controller: new TasksBrowserController(host), session };
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

const ANSI_SGR = /\[[0-9;]*m/g;
function strip(text: string): string {
  return text.replaceAll(ANSI_SGR, '');
}

/**
 * A subagent's task lives in that subagent's own registry: the main-agent list
 * cannot contain it, so /tasks must show it from the event-fed map, tag its
 * owner, and route output/stop through that owner (batch 2.2).
 */
describe('TasksBrowserController — subagent-owned tasks', () => {
  it('lists a subagent task with its owner and routes output/stop to that owner', async () => {
    const { state, controller, session } = makeHarness({
      fetched: [],
      subagentOwned: [[task({ taskId: 'bash-sub00001', description: 'sub build' }), 'agent-7']],
    });
    await controller.show();
    try {
      const browser = state.tasksBrowser;
      if (browser === undefined) throw new Error('browser did not open');

      const rendered = strip(browser.component.render(200).join('\n'));
      expect(rendered).toContain('bash-sub00001');
      expect(rendered).toContain('来自 coder');

      // Selection (tail) already routed to the owner.
      expect(session.getBackgroundTaskOutput).toHaveBeenCalledWith('bash-sub00001', {
        tail: 4000,
        agentId: 'agent-7',
      });

      // Enter → full output.
      browser.component.handleInput('\r');
      await Promise.resolve();
      await Promise.resolve();
      expect(session.getBackgroundTaskOutput).toHaveBeenCalledWith('bash-sub00001', {
        agentId: 'agent-7',
      });

      // S + Y → stop through the owner's registry.
      browser.component.handleInput('s');
      browser.component.handleInput('y');
      await Promise.resolve();
      expect(session.stopBackgroundTask).toHaveBeenCalledWith('bash-sub00001', {
        reason: expect.any(String),
        agentId: 'agent-7',
      });
    } finally {
      controller.close();
    }
  });

  it('keeps main-agent tasks on the default (main) registry', async () => {
    const { state, controller, session } = makeHarness();
    await controller.show();
    try {
      const browser = state.tasksBrowser;
      if (browser === undefined) throw new Error('browser did not open');
      expect(session.getBackgroundTaskOutput).toHaveBeenCalledWith('bash-aaaaaaaa', {
        tail: 4000,
        agentId: undefined,
      });

      browser.component.handleInput('\r');
      await Promise.resolve();
      await Promise.resolve();
      expect(session.getBackgroundTaskOutput).toHaveBeenCalledWith('bash-aaaaaaaa', {
        agentId: undefined,
      });
    } finally {
      controller.close();
    }
  });
});
