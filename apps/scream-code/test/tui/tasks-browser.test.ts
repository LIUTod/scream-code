import type { Terminal } from '@liutod-scream/pi-tui';
import type { BackgroundTaskInfo, BackgroundTaskStatus } from '@scream-code/scream-code-sdk';
import { describe, expect, it, vi } from 'vitest';

import {
  TasksBrowserApp,
  type TasksBrowserProps,
  type TasksFilter,
} from '@/tui/components/dialogs/tasks-browser';
import { darkColors } from '@/tui/theme/colors';
import type { AgentRow } from '@/tui/utils/subagent-instances';

const ANSI_SGR = /\[[0-9;]*m/g;
function strip(text: string): string {
  return text.replaceAll(ANSI_SGR, '');
}

/** Detail-pane row: the component left-pads labels to 14 columns. */
function detailRow(label: string, value: string): string {
  return `${label.padEnd(14)}${value}`;
}

/** Minimal Terminal stub — only `rows` is read by the component. */
function fakeTerminal(rows: number, columns = 120): Terminal {
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

function task(overrides: Partial<BackgroundTaskInfo> = {}): BackgroundTaskInfo {
  return {
    taskId: 'bash-abcd1234',
    command: 'npm run dev',
    description: 'dev server',
    status: 'running',
    pid: 1234,
    exitCode: null,
    startedAt: Date.now() - 60_000,
    endedAt: null,
    ...overrides,
  };
}

function makeProps(overrides: Partial<TasksBrowserProps> = {}): TasksBrowserProps {
  return {
    tasks: [],
    agents: [],
    filter: 'all',
    selectedTaskId: undefined,
    tailOutput: undefined,
    tailLoading: false,
    flashMessage: undefined,
    colors: darkColors,
    onSelect: vi.fn(),
    onToggleFilter: vi.fn(),
    onRefresh: vi.fn(),
    onCancel: vi.fn(),
    onStopConfirmed: vi.fn(),
    onOpenOutput: vi.fn(),
    onStopIgnored: vi.fn(),
    ...overrides,
  } as TasksBrowserProps;
}

function agentRow(overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    key: 'coder',
    type: 'coder',
    status: 'working',
    live: true,
    count: 1,
    detail: 'tool: Bash',
    lastActivityAt: Date.now() - 5_000,
    description: 'fix the parser',
    instanceId: 'agent-1',
    source: { kind: 'tool', name: 'WolfPack', description: 'parallel fix' },
    ancestors: [],
    chainTruncated: false,
    ...overrides,
  };
}

function makeApp(
  props: Partial<TasksBrowserProps> = {},
  rows = 30,
  columns = 120,
): TasksBrowserApp {
  return new TasksBrowserApp(makeProps(props), fakeTerminal(rows, columns));
}

describe('TasksBrowserApp — full-screen rendering', () => {
  it('fills exactly terminal.rows lines (height takeover)', () => {
    const rows = 30;
    const lines = makeApp({}, rows).render(120);
    expect(lines.length).toBe(rows);
  });

  it('reacts to terminal height changes', () => {
    const props = makeProps({
      tasks: [task({ taskId: 'bash-aaaaaaaa', status: 'running' })],
      selectedTaskId: 'bash-aaaaaaaa',
    });
    // Two terminals with different heights — verify render adapts.
    const small = new TasksBrowserApp(props, fakeTerminal(15, 120)).render(120);
    const big = new TasksBrowserApp(props, fakeTerminal(40, 120)).render(120);
    expect(small.length).toBe(15);
    expect(big.length).toBe(40);
  });

  it('shows the header row with TASK BROWSER title and counts', () => {
    const props: Partial<TasksBrowserProps> = {
      tasks: [
        task({ taskId: 'bash-aaaaaaaa', status: 'running' }),
        task({ taskId: 'agent-bbbbbbbb', status: 'completed' }),
      ],
    };
    const out = strip(makeApp(props).render(120).join('\n'));
    expect(out).toContain('TASK BROWSER');
    expect(out).toContain('filter=ALL');
    expect(out).toContain('1 运行中');
    expect(out).toContain('1 已完成');
    expect(out).toContain('2 总计');
  });

  it('renders three framed panes: Tasks / Detail / Preview Output', () => {
    const out = strip(
      makeApp({
        tasks: [task({ taskId: 'bash-aaaaaaaa', status: 'running' })],
        selectedTaskId: 'bash-aaaaaaaa',
      })
        .render(120)
        .join('\n'),
    );
    expect(out).toContain('Tasks [all]');
    expect(out).toContain('详情');
    expect(out).toContain('Preview Output');
  });

  it('shows the selected task details in the Detail pane', () => {
    const out = strip(
      makeApp({
        tasks: [
          task({
            taskId: 'bash-aaaaaaaa',
            status: 'running',
            description: 'long running task',
            pid: 9999,
          }),
        ],
        selectedTaskId: 'bash-aaaaaaaa',
      })
        .render(120)
        .join('\n'),
    );
    expect(out).toContain('任务 ID：');
    expect(out).toContain('bash-aaaaaaaa');
    expect(out).toContain('long running task');
  });

  it('renders tail output in the Preview Output pane', () => {
    const out = strip(
      makeApp({
        tasks: [task({ taskId: 'bash-aaaaaaaa' })],
        selectedTaskId: 'bash-aaaaaaaa',
        tailOutput: 'ready in 432ms\nlistening on :3000',
      })
        .render(120)
        .join('\n'),
    );
    expect(out).toContain('ready in 432ms');
    expect(out).toContain('listening on :3000');
  });

  it('strips terminal control sequences from tail output before rendering', () => {
    const out = strip(
      makeApp({
        tasks: [task({ taskId: 'bash-aaaaaaaa' })],
        selectedTaskId: 'bash-aaaaaaaa',
        tailOutput: 'progress 10%\rprogress 90%\u001B[2Jdone',
      })
        .render(120)
        .join('\n'),
    );
    // The raw escape sequence is gone and the pieces are joined contiguously.
    expect(out).not.toContain('progress 10%\rprogress 90%\u001B[2Jdone');
    expect(out).toContain('progress 10%progress 90%done');
  });

  it('shows a loading state when tail is loading', () => {
    const out = strip(
      makeApp({
        tasks: [task({ taskId: 'bash-aaaaaaaa' })],
        selectedTaskId: 'bash-aaaaaaaa',
        tailLoading: true,
      })
        .render(120)
        .join('\n'),
    );
    expect(out).toContain('[loading');
  });

  it('shows empty-state copy in the Tasks pane when no tasks', () => {
    const out = strip(makeApp().render(120).join('\n'));
    expect(out).toContain('本会话无后台任务。');
  });

  it('filters out terminal tasks when filter=active', () => {
    const tasks = [
      task({ taskId: 'bash-aaaaaaaa', status: 'running' }),
      task({ taskId: 'bash-bbbbbbbb', status: 'completed' }),
    ];
    const out = strip(makeApp({ tasks, filter: 'active' }).render(120).join('\n'));
    expect(out).toContain('bash-aaaaaaaa');
    expect(out).not.toContain('bash-bbbbbbbb');
  });

  it('renders without throwing for every BackgroundTaskStatus', () => {
    const statuses: BackgroundTaskStatus[] = [
      'running',
      'awaiting_approval',
      'completed',
      'failed',
      'killed',
      'lost',
    ];
    for (const status of statuses) {
      const props = makeProps({
        tasks: [task({ taskId: 'bash-aaaaaaaa', status })],
        selectedTaskId: 'bash-aaaaaaaa',
      });
      expect(() => new TasksBrowserApp(props, fakeTerminal(30)).render(120)).not.toThrow();
    }
  });

  it('falls back to a single line when the terminal is too small', () => {
    const out = strip(makeApp({}, 5, 30).render(30).join('\n'));
    expect(out).toContain('too small');
  });
});

describe('TasksBrowserApp — input handling', () => {
  it('Esc invokes onCancel', () => {
    const onCancel = vi.fn();
    const app = makeApp({ onCancel });
    app.handleInput('');
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('q invokes onCancel', () => {
    const onCancel = vi.fn();
    makeApp({ onCancel }).handleInput('q');
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('Tab invokes onToggleFilter', () => {
    const onToggleFilter = vi.fn();
    makeApp({ onToggleFilter }).handleInput('\t');
    expect(onToggleFilter).toHaveBeenCalledTimes(1);
  });

  it('R invokes onRefresh', () => {
    const onRefresh = vi.fn();
    makeApp({ onRefresh }).handleInput('r');
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('arrow keys move selection and invoke onSelect', () => {
    const onSelect = vi.fn();
    const tasks = [
      task({ taskId: 'bash-aaaaaaaa', status: 'running', startedAt: 1 }),
      task({ taskId: 'bash-bbbbbbbb', status: 'running', startedAt: 2 }),
      task({ taskId: 'bash-cccccccc', status: 'running', startedAt: 3 }),
    ];
    const app = makeApp({ tasks, selectedTaskId: 'bash-aaaaaaaa', onSelect });
    app.handleInput('[B'); // ↓
    expect(onSelect).toHaveBeenLastCalledWith('bash-bbbbbbbb');
    app.handleInput('j');
    expect(onSelect).toHaveBeenLastCalledWith('bash-cccccccc');
    app.handleInput('[A'); // ↑
    expect(onSelect).toHaveBeenLastCalledWith('bash-bbbbbbbb');
  });

  it('Enter and O both invoke onOpenOutput', () => {
    const onOpenOutput = vi.fn();
    const app = makeApp({
      tasks: [task({ taskId: 'bash-aaaaaaaa' })],
      selectedTaskId: 'bash-aaaaaaaa',
      onOpenOutput,
    });
    app.handleInput('o');
    app.handleInput('\r');
    expect(onOpenOutput).toHaveBeenCalledTimes(2);
    expect(onOpenOutput).toHaveBeenCalledWith('bash-aaaaaaaa');
  });
});

// When a terminal (e.g. the VSCode integrated terminal) enables the Kitty
// keyboard protocol disambiguate flag, ordinary printable keys arrive as
// CSI-u sequences: `r` → "\x1b[114u", `q` → "\x1b[113u". These tests pin
// down that the tasks panel's literal-character shortcuts still fire
// under Kitty mode.
describe('TasksBrowserApp — Kitty CSI-u printable input', () => {
  const kitty = (ch: string): string => `\u001B[${String(ch.codePointAt(0) ?? 0)}u`;

  it('Kitty-encoded q invokes onCancel', () => {
    const onCancel = vi.fn();
    makeApp({ onCancel }).handleInput(kitty('q'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('Kitty-encoded r invokes onRefresh', () => {
    const onRefresh = vi.fn();
    makeApp({ onRefresh }).handleInput(kitty('r'));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('Kitty-encoded j moves selection down', () => {
    const onSelect = vi.fn();
    const tasks = [
      task({ taskId: 'bash-aaaaaaaa', status: 'running', startedAt: 1 }),
      task({ taskId: 'bash-bbbbbbbb', status: 'running', startedAt: 2 }),
    ];
    const app = makeApp({ tasks, selectedTaskId: 'bash-aaaaaaaa', onSelect });
    app.handleInput(kitty('j'));
    expect(onSelect).toHaveBeenLastCalledWith('bash-bbbbbbbb');
  });

  it('Kitty-encoded o invokes onOpenOutput', () => {
    const onOpenOutput = vi.fn();
    const app = makeApp({
      tasks: [task({ taskId: 'bash-aaaaaaaa' })],
      selectedTaskId: 'bash-aaaaaaaa',
      onOpenOutput,
    });
    app.handleInput(kitty('o'));
    expect(onOpenOutput).toHaveBeenCalledWith('bash-aaaaaaaa');
  });

  it('Kitty-encoded s → y confirms a stop', () => {
    const onStopConfirmed = vi.fn();
    const app = makeApp({
      tasks: [task({ taskId: 'bash-aaaaaaaa', status: 'running' })],
      selectedTaskId: 'bash-aaaaaaaa',
      onStopConfirmed,
    });
    app.handleInput(kitty('s'));
    app.handleInput(kitty('y'));
    expect(onStopConfirmed).toHaveBeenCalledWith('bash-aaaaaaaa');
  });
});

describe('TasksBrowserApp — stop confirmation', () => {
  it('S → y confirms a stop and invokes onStopConfirmed', () => {
    const onStopConfirmed = vi.fn();
    const app = makeApp({
      tasks: [task({ taskId: 'bash-aaaaaaaa', status: 'running' })],
      selectedTaskId: 'bash-aaaaaaaa',
      onStopConfirmed,
    });
    app.handleInput('s');
    const after = strip(app.render(120).join('\n'));
    expect(after).toContain('停止 bash-aaaaaaaa?');
    app.handleInput('y');
    expect(onStopConfirmed).toHaveBeenCalledWith('bash-aaaaaaaa');
    expect(strip(app.render(120).join('\n'))).not.toContain('Stop bash-aaaaaaaa?');
  });

  it('S → n cancels without firing onStopConfirmed', () => {
    const onStopConfirmed = vi.fn();
    const app = makeApp({
      tasks: [task({ taskId: 'bash-aaaaaaaa', status: 'running' })],
      selectedTaskId: 'bash-aaaaaaaa',
      onStopConfirmed,
    });
    app.handleInput('s');
    app.handleInput('n');
    expect(onStopConfirmed).not.toHaveBeenCalled();
    expect(strip(app.render(120).join('\n'))).not.toContain('Stop bash-aaaaaaaa?');
  });

  it('S → Esc cancels the confirm without closing the panel', () => {
    const onStopConfirmed = vi.fn();
    const onCancel = vi.fn();
    const app = makeApp({
      tasks: [task({ taskId: 'bash-aaaaaaaa', status: 'running' })],
      selectedTaskId: 'bash-aaaaaaaa',
      onStopConfirmed,
      onCancel,
    });
    app.handleInput('s');
    app.handleInput('');
    expect(onStopConfirmed).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('S on a terminal task invokes onStopIgnored and stays out of confirm mode', () => {
    const onStopConfirmed = vi.fn();
    const onStopIgnored = vi.fn();
    const app = makeApp({
      tasks: [task({ taskId: 'bash-aaaaaaaa', status: 'completed', exitCode: 0 })],
      selectedTaskId: 'bash-aaaaaaaa',
      onStopConfirmed,
      onStopIgnored,
    });
    app.handleInput('s');
    expect(onStopIgnored).toHaveBeenCalledWith('bash-aaaaaaaa', 'terminal');
    expect(onStopConfirmed).not.toHaveBeenCalled();
    expect(strip(app.render(120).join('\n'))).not.toContain('Stop bash-aaaaaaaa?');
  });

  it('navigation during confirm mode is locked out', () => {
    const onSelect = vi.fn();
    const onStopConfirmed = vi.fn();
    const tasks = [
      task({ taskId: 'bash-aaaaaaaa', status: 'running', startedAt: 1 }),
      task({ taskId: 'bash-bbbbbbbb', status: 'running', startedAt: 2 }),
    ];
    const app = makeApp({ tasks, selectedTaskId: 'bash-aaaaaaaa', onSelect, onStopConfirmed });
    app.handleInput('s');
    onSelect.mockClear();
    app.handleInput('[B'); // ↓ arrow should be swallowed
    expect(onSelect).not.toHaveBeenCalled();
    expect(strip(app.render(120).join('\n'))).not.toContain('Stop bash-aaaaaaaa?');
  });
});

describe('TasksBrowserApp — setProps', () => {
  it('keeps selection across prop updates when the task still exists', () => {
    const tasks = [
      task({ taskId: 'bash-aaaaaaaa', status: 'running' }),
      task({ taskId: 'bash-bbbbbbbb', status: 'running' }),
    ];
    const app = makeApp({ tasks, selectedTaskId: 'bash-bbbbbbbb' });
    app.setProps({
      ...makeProps({
        tasks: [...tasks, task({ taskId: 'bash-cccccccc', status: 'completed' })],
        selectedTaskId: 'bash-bbbbbbbb',
      }),
    });
    const out = strip(app.render(120).join('\n'));
    expect(out).toContain('bash-bbbbbbbb');
  });

  it('switches the filter via setProps without throwing', () => {
    const tasks = [task({ status: 'completed' })];
    const filters: TasksFilter[] = ['all', 'active', 'agents', 'all'];
    const app = makeApp({ tasks });
    for (const filter of filters) {
      expect(() => {
        app.setProps(makeProps({ tasks, filter }));
      }).not.toThrow();
    }
  });
});

describe('TasksBrowserApp — agents view', () => {
  it('renders the Agents pane, the agent detail and the no-output note', () => {
    const out = strip(
      makeApp({
        agents: [agentRow({ ancestors: ['researcher'], chainTruncated: false })],
        filter: 'agents',
      })
        .render(120)
        .join('\n'),
    );
    expect(out).toContain('filter=AGENTS');
    expect(out).toContain('子代理 [1]');
    expect(out).toContain('coder');
    expect(out).toContain('工作中');
    expect(out).toContain('tool: Bash');
    expect(out).toContain('代理详情');
    expect(out).toContain(detailRow('类型：', 'coder'));
    expect(out).toContain(detailRow('来源：', 'WolfPack · parallel fix'));
    expect(out).toContain(detailRow('父链：', '主代理 → researcher → coder'));
    expect(out).toContain(detailRow('描述：', 'fix the parser'));
    expect(out).toContain(detailRow('最新活动：', 'tool: Bash'));
    expect(out).toContain(detailRow('实例：', 'agent-1'));
    expect(out).toContain('子代理输出显示在对话卡片中');
  });

  it('names each attribution kind and keeps an unresolvable source honest', () => {
    const rows = [
      agentRow({ key: 'coder', type: 'coder', source: { kind: 'agent', name: 'researcher', description: 'survey' } }),
      agentRow({ key: 'verify', type: 'verify', source: { kind: 'rlm', name: undefined, description: undefined } }),
      agentRow({ key: 'writer', type: 'writer', source: { kind: 'main', name: undefined, description: undefined } }),
      agentRow({ key: 'oracle', type: 'oracle', source: { kind: 'unknown', name: undefined, description: undefined } }),
    ];
    const app = makeApp({ agents: rows, filter: 'agents' });
    const frames: string[] = [];
    for (let i = 0; i < rows.length; i++) {
      if (i > 0) app.handleInput('j');
      frames.push(strip(app.render(120).join('\n')));
    }
    expect(frames[0]).toContain(detailRow('来源：', '由 researcher 派生 · survey'));
    expect(frames[1]).toContain(detailRow('来源：', 'RLM 派生'));
    expect(frames[2]).toContain(detailRow('来源：', '主代理直接派生'));
    expect(frames[3]).toContain(detailRow('来源：', '独立（无父线索）'));
  });

  it('shows terminal outcomes and the live/ended header split', () => {
    const out = strip(
      makeApp({
        agents: [
          agentRow(),
          agentRow({ key: 'verify', type: 'verify', status: 'failed', live: false, instanceId: undefined }),
        ],
        filter: 'agents',
      })
        .render(120)
        .join('\n'),
    );
    expect(out).toContain('1 运行中');
    expect(out).toContain('1 已结束');
    expect(out).toContain('已失败');
  });

  it('shows an empty state when no subagent ran in this session', () => {
    const out = strip(makeApp({ agents: [], filter: 'agents' }).render(120).join('\n'));
    expect(out).toContain('子代理 [0]');
    expect(out).toContain('本会话无活动子代理。');
    expect(out).toContain('0 子代理');
  });

  it('moves the agent selection locally without touching the task selection', () => {
    const onSelect = vi.fn();
    const app = makeApp({
      agents: [
        agentRow({ key: 'coder', type: 'coder' }),
        agentRow({ key: 'verify', type: 'verify', status: 'outputting' }),
      ],
      filter: 'agents',
      onSelect,
    });
    app.handleInput('j');
    expect(onSelect).not.toHaveBeenCalled();
    expect(strip(app.render(120).join('\n'))).toContain(detailRow('类型：', 'verify'));
    app.handleInput('k');
    expect(strip(app.render(120).join('\n'))).toContain(detailRow('类型：', 'coder'));
  });

  it('keeps the same agent selected across prop refreshes by slot key', () => {
    const app = makeApp({
      agents: [agentRow({ key: 'coder' }), agentRow({ key: 'verify', type: 'verify' })],
      filter: 'agents',
    });
    app.handleInput('j');
    expect(strip(app.render(120).join('\n'))).toContain(detailRow('类型：', 'verify'));
    // Rows re-sort on refresh: the same key must stay selected.
    app.setProps(
      makeProps({
        agents: [agentRow({ key: 'verify', type: 'verify' }), agentRow({ key: 'coder' })],
        filter: 'agents',
      }),
    );
    expect(strip(app.render(120).join('\n'))).toContain(detailRow('类型：', 'verify'));
  });

  it('keeps stop, output-open and confirm keys inert in the agents view', () => {
    const onOpenOutput = vi.fn();
    const onStopConfirmed = vi.fn();
    const onStopIgnored = vi.fn();
    const app = makeApp({
      agents: [agentRow()],
      filter: 'agents',
      onOpenOutput,
      onStopConfirmed,
      onStopIgnored,
    });
    app.handleInput('o');
    app.handleInput('\r');
    app.handleInput('s');
    app.handleInput('y');
    expect(onOpenOutput).not.toHaveBeenCalled();
    expect(onStopConfirmed).not.toHaveBeenCalled();
    expect(onStopIgnored).not.toHaveBeenCalled();
    expect(strip(app.render(120).join('\n'))).not.toContain('停止 coder?');
  });

  it('drops task-only key hints from the footer and keeps Tab/R/Esc wired', () => {
    const onToggleFilter = vi.fn();
    const onRefresh = vi.fn();
    const onCancel = vi.fn();
    const app = makeApp({
      agents: [agentRow()],
      filter: 'agents',
      onToggleFilter,
      onRefresh,
      onCancel,
    });
    const out = strip(app.render(120).join('\n'));
    expect(out).not.toContain('Enter/O');
    expect(out).toContain('刷新');
    app.handleInput('\t');
    app.handleInput('r');
    app.handleInput('q');
    expect(onToggleFilter).toHaveBeenCalledTimes(1);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('TasksBrowserApp — close() clears the pending-stop timer', () => {
  it('close() disarms the confirm timer and exits confirm mode', () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    try {
      const onStopConfirmed = vi.fn();
      const app = makeApp({
        tasks: [task({ taskId: 'bash-aaaaaaaa', status: 'running' })],
        selectedTaskId: 'bash-aaaaaaaa',
        onStopConfirmed,
      });
      app.handleInput('s');
      expect(strip(app.render(120).join('\n'))).toContain('停止 bash-aaaaaaaa?');

      app.close();

      // clearPendingStop must clearTimeout the pendingStopTimer.
      expect(clearTimeoutSpy).toHaveBeenCalled();
      // Confirm mode is gone: a follow-up 'y' must not fire onStopConfirmed.
      app.handleInput('y');
      expect(onStopConfirmed).not.toHaveBeenCalled();
      expect(strip(app.render(120).join('\n'))).not.toContain('停止 bash-aaaaaaaa?');
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it('close() is safe when no confirm is pending', () => {
    const app = makeApp({
      tasks: [task({ taskId: 'bash-aaaaaaaa', status: 'running' })],
      selectedTaskId: 'bash-aaaaaaaa',
    });
    expect(() => app.close()).not.toThrow();
  });
});
