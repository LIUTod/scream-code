import type {
  AgentReplayRecord,
  BackgroundTaskInfo,
  ContentPart,
  Event,
  PromptOrigin,
  ResumedAgentState,
  Role,
  Session,
  ToolCall,
} from '@scream-code/scream-code-sdk';
import { describe, expect, it, vi } from 'vitest';
import { t } from '@scream-code/config';

import { ScreamTUI, type ScreamTUIStartupInput, type TUIState } from '#/tui/scream-tui';
import type { SessionEventHandler } from '#/tui/controllers/session-event-handler';
import type { StreamingUIController } from '#/tui/controllers/streaming-ui';
import { AgentGroupComponent } from '#/tui/components/messages/agent-group';
import { ActivityGroupComponent } from '#/tui/components/messages/activity-group';
import { NoticeMessageComponent } from '#/tui/components/messages/status-message';
import { ToolCallComponent } from '#/tui/components/messages/tool-call';

vi.mock('#/tui/utils/open-url', () => ({ openUrl: vi.fn() }));

interface ReplayDriver {
  readonly state: TUIState;
  readonly streamingUI: StreamingUIController;
  readonly sessionEventHandler: SessionEventHandler;
  init(): Promise<boolean>;
  switchToSession(session: Session, statusMessage: string): Promise<void>;
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
      autoStart: false,
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

function message(
  role: Role,
  content: readonly ContentPart[],
  extra: {
    readonly toolCalls?: readonly ToolCall[];
    readonly toolCallId?: string;
    readonly origin?: PromptOrigin;
    readonly isError?: boolean;
  } = {},
): AgentReplayRecord {
  return {
    type: 'message',
    message: {
      role,
      content: [...content],
      toolCalls: [...(extra.toolCalls ?? [])],
      toolCallId: extra.toolCallId,
      origin: extra.origin,
      isError: extra.isError,
    },
  };
}

function toolCall(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return {
    type: 'function',
    id,
    name,
    arguments: JSON.stringify(args),
  };
}

function baseAgentState(
  replay: readonly AgentReplayRecord[],
  overrides: Partial<ResumedAgentState> = {},
): ResumedAgentState {
  return {
    type: 'main',
    config: {
      cwd: '/tmp/proj-a',
      modelAlias: 'k2',
      provider: undefined,
      modelCapabilities: {
        image_in: false,
        video_in: false,
        audio_in: false,
        thinking: false,
        tool_use: true,
        max_context_tokens: 100,
      },
      thinkingLevel: 'off',
      systemPrompt: '',
    },
    context: { history: [], tokenCount: 0 },
    replay,
    permission: { mode: 'manual', rules: [] },
    plan: null,
    usage: {},
    tools: [],
    toolStore: {},
    background: [],
    ...overrides,
  };
}

function makeSession(
  replay: readonly AgentReplayRecord[],
  overrides: Partial<ResumedAgentState> = {},
): Session {
  const agent = baseAgentState(replay, overrides);
  return {
    id: 'ses-replay',
    model: 'k2',
    summary: { title: null },
    getStatus: vi.fn(async () => ({
      model: 'k2',
      thinkingLevel: 'off',
      permission: 'manual',
      planMode: 'off',
      contextTokens: 0,
      maxContextTokens: 100,
      contextUsage: 0,
    })),
    setApprovalHandler: vi.fn(),
    setQuestionHandler: vi.fn(),
    setModel: vi.fn(async () => {}),
    setThinking: vi.fn(async () => {}),
    setPermission: vi.fn(async () => {}),
    setPlanMode: vi.fn(async () => {}),
    getGoal: vi.fn(async () => ({ goal: null })),
    onEvent: vi.fn(() => vi.fn()),
    listMcpServers: vi.fn(async () => []),
    listSkills: vi.fn(async () => []),
    getResumeState: vi.fn(() => ({
      sessionMetadata: {},
      agents: { main: agent },
    })),
    close: vi.fn(async () => {}),
  } as unknown as Session;
}

function makeHarness(initialSession: Session) {
  return {
    setSubagentModelBindings: vi.fn(),
    getConfig: vi.fn(async () => ({
      models: {
        k2: { model: 'scream-cli-v1', maxContextSize: 100 },
      },
    })),
    setConfig: vi.fn(async () => ({ providers: {} })),
    createSession: vi.fn(async () => initialSession),
    resumeSession: vi.fn(async () => initialSession),
    forkSession: vi.fn(async () => initialSession),
    listSessions: vi.fn(async () => []),
    close: vi.fn(async () => {}),
    interactiveAgentId: 'main',
    auth: {
      status: vi.fn(),
      login: vi.fn(),
      logout: vi.fn(),
      getManagedUsage: vi.fn(),
      submitFeedback: vi.fn(async () => ({ kind: 'ok' })),
    },
  };
}

async function makeDriver(initialSession: Session): Promise<ReplayDriver> {
  const driver = new ScreamTUI(
    makeHarness(initialSession) as never,
    makeStartupInput(),
  ) as unknown as ReplayDriver;
  vi.spyOn(driver.state.ui, 'requestRender').mockImplementation(() => {});
  vi.spyOn(driver.state.terminal, 'setProgress').mockImplementation(() => {});
  await driver.init();
  return driver;
}

async function replayIntoDriver(
  replay: readonly AgentReplayRecord[],
  overrides: Partial<ResumedAgentState> = {},
): Promise<ReplayDriver> {
  const initial = makeSession([]);
  const resumed = makeSession(replay, overrides);
  const driver = await makeDriver(initial);
  await driver.switchToSession(resumed, 'Resumed session (ses-replay).');
  return driver;
}

function backgroundTask(
  taskId: string,
  description: string,
  status: BackgroundTaskInfo['status'] = 'running',
  agentId?: string,
): BackgroundTaskInfo {
  return {
    taskId,
    command: `[agent] ${description}`,
    description,
    status,
    pid: 0,
    exitCode: status === 'completed' ? 0 : null,
    startedAt: 1,
    endedAt: status === 'running' ? null : 2,
    agentId,
  };
}

describe('ScreamTUI resume message replay', () => {
  it('groups replayed Agent calls from one assistant message using live grouping', async () => {
    const replay: AgentReplayRecord[] = [
      message('user', [{ type: 'text', text: 'run two agents' }]),
      message('assistant', [], {
        toolCalls: [
          toolCall('call_agent_1', 'Agent', {
            description: 'Review API',
            subagent_type: 'reviewer',
          }),
          toolCall('call_agent_2', 'Agent', {
            description: 'Review tests',
            subagent_type: 'reviewer',
          }),
        ],
      }),
      message('tool', [{ type: 'text', text: 'agent one done' }], {
        toolCallId: 'call_agent_1',
      }),
      message('tool', [{ type: 'text', text: 'agent two done' }], {
        toolCallId: 'call_agent_2',
      }),
    ];

    const driver = await replayIntoDriver(replay);
    const group = driver.state.transcriptContainer.children.find(
      (child) => child instanceof AgentGroupComponent,
    );

    expect(group).toBeInstanceOf(AgentGroupComponent);
    expect((group as AgentGroupComponent).size()).toBe(2);
    expect(driver.streamingUI.hasPendingAgentGroup()).toBe(false);
    expect(driver.streamingUI.getToolComponent('call_agent_1')).toBeUndefined();
    expect(driver.streamingUI.getToolComponent('call_agent_2')).toBeUndefined();
  });

  it('folds replayed Read calls into the turn activity block', async () => {
    const replay: AgentReplayRecord[] = [
      message('user', [{ type: 'text', text: 'read files' }]),
      message('assistant', [], {
        toolCalls: [
          toolCall('call_read_1', 'Read', { file_path: '/tmp/proj-a/src/a.ts' }),
          toolCall('call_read_2', 'Read', { file_path: '/tmp/proj-a/src/b.ts' }),
        ],
      }),
      message('tool', [{ type: 'text', text: 'line a\nline b\n' }], {
        toolCallId: 'call_read_1',
      }),
      message('tool', [{ type: 'text', text: 'line c\n' }], {
        toolCallId: 'call_read_2',
      }),
    ];

    const driver = await replayIntoDriver(replay);
    const blocks = driver.state.transcriptContainer.children.filter(
      (child) => child instanceof ActivityGroupComponent,
    );

    expect(blocks).toHaveLength(1);
    // Both reads are rows of the same block, in the order they were called.
    const rows = (blocks[0] as ActivityGroupComponent)
      .render(100)
      .map((line) => line.replaceAll(/\u001B\[[0-9;]*m/g, ''))
      .join('\n');
    expect(rows).toContain('a.ts');
    expect(rows).toContain('b.ts');
    expect(rows.indexOf('a.ts')).toBeLessThan(rows.indexOf('b.ts'));
    expect(driver.streamingUI.getToolComponent('call_read_1')).toBeUndefined();
    expect(driver.streamingUI.getToolComponent('call_read_2')).toBeUndefined();
  });

  it('keeps an orphan approval in the turn it was answered in', async () => {
    const driver = await replayIntoDriver([
      message('user', [{ type: 'text', text: 'first' }]),
      {
        type: 'approval_result',
        record: {
          turnId: 0,
          toolCallId: 'call_orphan',
          toolName: 'Bash',
          action: 'run ls',
          result: { decision: 'approved' },
        },
      },
      message('user', [{ type: 'text', text: 'second' }]),
      message('assistant', [], {
        toolCalls: [toolCall('call_bash_2', 'Bash', { command: 'ls' })],
      }),
      message('tool', [{ type: 'text', text: 'ok' }], { toolCallId: 'call_bash_2' }),
    ]);

    const stripAnsi = (line: string): string => line.replaceAll(/\u001B\[[0-9;]*m/g, '');
    const blocks = driver.state.transcriptContainer.children.filter(
      (child) => child instanceof ActivityGroupComponent,
    );

    // The later turn's block must not adopt an outcome from before it.
    expect(blocks).toHaveLength(1);
    const blockRows = (blocks[0] as ActivityGroupComponent).render(120).map(stripAnsi).join('\n');
    expect(blockRows).not.toContain('已批准');
    const transcript = driver.state.transcriptContainer.render(120).map(stripAnsi).join('\n');
    expect(transcript).toContain('已批准: run ls');
  });

  it('lands a replayed approval inside the block that owns the call', async () => {
    const driver = await replayIntoDriver([
      message('user', [{ type: 'text', text: 'write a file' }]),
      message('assistant', [], {
        toolCalls: [toolCall('call_write_1', 'Write', { file_path: '/tmp/proj-a/a.py' })],
      }),
      {
        type: 'approval_result',
        record: {
          turnId: 0,
          toolCallId: 'call_write_1',
          toolName: 'Write',
          action: 'Writing /tmp/proj-a/a.py',
          result: { decision: 'approved', scope: 'session' },
        },
      },
      message('tool', [{ type: 'text', text: 'ok' }], { toolCallId: 'call_write_1' }),
    ]);

    const blocks = driver.state.transcriptContainer.children.filter(
      (child) => child instanceof ActivityGroupComponent,
    );

    expect(blocks).toHaveLength(1);
    const rows = (blocks[0] as ActivityGroupComponent)
      .render(120)
      .map((line) => line.replaceAll(/\u001B\[[0-9;]*m/g, ''))
      .join('\n');
    // The approval is a step of the block, not a message of its own: it carries
    // the timeline branch rather than the standalone notice indent.
    expect(rows).toContain('└─ 已批准（当前会话） · Writing /tmp/proj-a/a.py');
    expect(driver.state.transcriptEntries.filter((item) => item.renderMode === 'notice')).toHaveLength(0);
  });

  it('hydrates todo and background snapshot state from resumed main agent', async () => {
    const driver = await replayIntoDriver([], {
      toolStore: {
        todo: [
          { title: 'Review resume snapshot', status: 'done' },
          { title: 'Render replay transcript', status: 'in_progress' },
          { title: '', status: 'pending' },
        ],
      },
      background: [
        backgroundTask('agent-bg1', 'Review long-running work', 'running'),
        backgroundTask('bash-bg1', 'Build package', 'completed'),
      ],
    });

    expect(driver.state.todoPanel.getTodos()).toEqual([
      { title: 'Review resume snapshot', status: 'done' },
      { title: 'Render replay transcript', status: 'in_progress' },
    ]);
    expect(driver.sessionEventHandler.backgroundTasks.has('agent-bg1')).toBe(true);
    expect(driver.sessionEventHandler.backgroundTasks.has('bash-bg1')).toBe(true);
    expect(driver.sessionEventHandler.backgroundTaskTranscriptedTerminal.has('bash-bg1')).toBe(true);
  });

  it('renders replayed bash background notifications as bash tasks', async () => {
    const driver = await replayIntoDriver(
      [
        message('user', [{ type: 'text', text: 'Background task lost.' }], {
          origin: {
            kind: 'background_task',
            taskId: 'bash-lost0000',
            status: 'lost',
            notificationId: 'task:bash-lost0000:lost',
          },
        }),
      ],
      {
        background: [backgroundTask('bash-lost0000', 'Background timestamp logger', 'lost')],
      },
    );

    const status = driver.state.transcriptEntries.find(
      (entry) => entry.backgroundAgentStatus !== undefined,
    );

    expect(status?.backgroundAgentStatus?.headline).toBe('bash 任务 已丢失');
    expect(status?.backgroundAgentStatus?.detail).toContain('Background timestamp logger');
    expect(status?.backgroundAgentStatus?.headline).not.toContain('agent');
  });

  it('renders only the most recent ten visible user turns', async () => {
    const replay = Array.from({ length: 12 }, (_, index) => [
      message('user', [{ type: 'text', text: `prompt ${index}` }]),
      message('assistant', [{ type: 'text', text: `answer ${index}` }]),
    ]).flat();

    const driver = await replayIntoDriver(replay);

    expect(
      driver.state.transcriptEntries
        .filter((entry) => entry.kind === 'user')
        .map((entry) => entry.content),
    ).toEqual([
      'prompt 2',
      'prompt 3',
      'prompt 4',
      'prompt 5',
      'prompt 6',
      'prompt 7',
      'prompt 8',
      'prompt 9',
      'prompt 10',
      'prompt 11',
    ]);
    expect(
      driver.state.transcriptEntries
        .filter((entry) => entry.kind === 'assistant')
        .map((entry) => entry.content),
    ).toEqual([
      'answer 2',
      'answer 3',
      'answer 4',
      'answer 5',
      'answer 6',
      'answer 7',
      'answer 8',
      'answer 9',
      'answer 10',
      'answer 11',
    ]);
  });

  it('skips cron_job origin records during replay', async () => {
    const cronFire =
      '<cron-fire jobId="job-1" cron="*/5 * * * *" recurring="true" coalescedCount="1">\nrun nightly\n</cron-fire>';
    const driver = await replayIntoDriver([
      message('user', [{ type: 'text', text: 'real prompt' }]),
      message('assistant', [{ type: 'text', text: 'real answer' }]),
      message('user', [{ type: 'text', text: cronFire }], {
        origin: {
          kind: 'cron_job',
          jobId: 'job-1',
          cron: '*/5 * * * *',
          recurring: true,
          coalescedCount: 1,
          stale: false,
        },
      }),
    ]);

    const transcript = driver.state.transcriptContainer.render(120).join('\n');
    expect(transcript).not.toContain('<cron-fire');
    expect(
      driver.state.transcriptEntries
        .filter((entry) => entry.kind === 'user')
        .map((entry) => entry.content),
    ).toEqual(['real prompt']);
  });

  it('skips cron_missed origin records during replay', async () => {
    const cronMissed =
      '<cron-fire jobId="job-2" missed="true" count="3">\n3 one-shot tasks missed while offline\n</cron-fire>';
    const driver = await replayIntoDriver([
      message('user', [{ type: 'text', text: 'real prompt' }]),
      message('assistant', [{ type: 'text', text: 'real answer' }]),
      message('user', [{ type: 'text', text: cronMissed }], {
        origin: { kind: 'cron_missed', count: 3 },
      }),
    ]);

    const transcript = driver.state.transcriptContainer.render(120).join('\n');
    expect(transcript).not.toContain('<cron-fire');
    expect(transcript).not.toContain('missed while offline');
    expect(
      driver.state.transcriptEntries
        .filter((entry) => entry.kind === 'user')
        .map((entry) => entry.content),
    ).toEqual(['real prompt']);
  });

  it('renders user-slash skill activation once without exposing injected prompt text', async () => {
    const activation = message(
      'user',
      [{ type: 'text', text: 'Review the requested file.\n\nUser request:\nsrc/app.ts' }],
      {
        origin: {
          kind: 'skill_activation',
          activationId: 'act-review',
          skillName: 'review',
          skillArgs: 'src/app.ts',
          trigger: 'user-slash',
        },
      },
    );

    const driver = await replayIntoDriver([activation, activation]);
    const transcript = driver.state.transcriptContainer.render(120).join('\n');

    expect(transcript).toContain('review');
    expect(transcript).toContain('src/app.ts');
    expect(transcript).not.toContain('Review the requested file');
    expect(driver.sessionEventHandler.renderedSkillActivationIds.has('act-review')).toBe(true);
  });

  it('renders replayed hook results as assistant transcript entries', async () => {
    const hookResult =
      '<hook_result hook_event="UserPromptSubmit">\nhook response 1\n</hook_result>\n' +
      '<hook_result hook_event="UserPromptSubmit">\nhook response 2\n</hook_result>';
    const driver = await replayIntoDriver([
      message('user', [{ type: 'text', text: 'prompt' }]),
      message('user', [{ type: 'text', text: hookResult }], {
        origin: { kind: 'hook_result', event: 'UserPromptSubmit' },
      }),
    ]);

    const transcript = driver.state.transcriptContainer.render(120).join('\n');

    expect(transcript).toContain('UserPromptSubmit hook');
    expect(transcript).toContain('hook response 1');
    expect(transcript).toContain('hook response 2');
  });

  it('renders plan permission and approval replay notices', async () => {
    const driver = await replayIntoDriver([
      { type: 'plan_updated', enabled: true },
      { type: 'permission_updated', mode: 'auto' },
      { type: 'permission_updated', mode: 'yolo' },
      { type: 'permission_updated', mode: 'manual' },
      {
        type: 'approval_result',
        record: {
          turnId: 0,
          toolCallId: 'call_bash',
          action: 'run command',
          toolName: 'Bash',
          result: {
            decision: 'approved',
            scope: 'session',
            selectedLabel: 'Approve for this session',
          },
        },
      },
      { type: 'plan_updated', enabled: false },
    ]);

    const transcript = driver.state.transcriptContainer.render(120).join('\n');

    expect(transcript).toContain('Plan mode: ON');
    expect(transcript).toContain('权限模式： auto');
    expect(transcript).toContain('YES 模式：开启');
    expect(transcript).toContain('YES 模式：关闭');
    expect(transcript).toContain('已批准（当前会话）: run command');
    expect(transcript).toContain('Plan mode: OFF');
  });

  it('keeps only the final approved plan card after rejected plan reviews', async () => {
    const driver = await replayIntoDriver([
      message('assistant', [], {
        toolCalls: [toolCall('call_exit_reject', 'ExitPlanMode', {})],
      }),
      {
        type: 'approval_result',
        record: {
          turnId: 0,
          toolCallId: 'call_exit_reject',
          action: 'Review plan',
          toolName: 'ExitPlanMode',
          result: { decision: 'rejected', selectedLabel: 'Reject' },
        },
      },
      message('tool', [{ type: 'text', text: 'Plan rejected by user. Plan mode remains active.' }], {
        toolCallId: 'call_exit_reject',
        isError: true,
      }),
      message('assistant', [], {
        toolCalls: [toolCall('call_exit_final', 'ExitPlanMode', {})],
      }),
      {
        type: 'approval_result',
        record: {
          turnId: 1,
          toolCallId: 'call_exit_final',
          action: 'Review plan',
          toolName: 'ExitPlanMode',
          result: { decision: 'approved', selectedLabel: 'Approve' },
        },
      },
      message(
        'tool',
        [
          {
            type: 'text',
            text:
              'Exited plan mode. Plan mode deactivated. All tools are now available.\n' +
              'Plan saved to: /tmp/plans/final-plan.md\n\n' +
              '## Approved Plan:\n# Final Plan\n\n- replay final approved plan',
          },
        ],
        { toolCallId: 'call_exit_final' },
      ),
      { type: 'plan_updated', enabled: false },
    ]);

    const transcript = driver.state.transcriptContainer.render(120).join('\n');

    expect(transcript).toContain('计划审查已拒绝');
    expect(transcript).toContain('Final Plan');
    expect(transcript).toContain('replay final approved plan');
    expect(transcript).not.toContain('Plan rejected by user.');
    expect(transcript).not.toContain('Plan mode: OFF');
  });

  it('replays a plan between two sealed blocks, matching the live shape', async () => {
    const driver = await replayIntoDriver([
      message('assistant', [], { toolCalls: [toolCall('call_read', 'Read', { file_path: 'a.ts' })] }),
      message('tool', [{ type: 'text', text: 'ok' }], { toolCallId: 'call_read' }),
      message('assistant', [], {
        toolCalls: [toolCall('call_exit', 'ExitPlanMode', { plan: 'Step one\nStep two' })],
      }),
      message('tool', [{ type: 'text', text: 'Exited plan mode.' }], { toolCallId: 'call_exit' }),
      message('assistant', [], { toolCalls: [toolCall('call_bash', 'Bash', { command: 'ls' })] }),
      message('tool', [{ type: 'text', text: 'file list' }], { toolCallId: 'call_bash' }),
    ]);

    const children = driver.state.transcriptContainer.children;
    const shape = children
      .map((child) =>
        child instanceof ActivityGroupComponent
          ? 'block'
          : child instanceof ToolCallComponent
            ? 'card'
            : 'other',
      )
      // Replay mounts its own scaffolding at the top of the transcript; only the
      // block/card order matters here.
      .filter((kind) => kind !== 'other');

    // The plan seals the block that led to it, and the work after it starts a
    // block of its own below the card — same shape the live session builds.
    expect(shape).toEqual(['block', 'card', 'block']);
    const rendered = children.map((child) => child.render(120).join('\n')).join('\n');
    expect(rendered).toContain('Step one');
  });
});


describe('replayed internal injections', () => {
  it('renders a replayed child→parent request as a notice, not as raw XML', async () => {
    // Verbatim shape injected by submitChildRequest() in agent-core.
    const notification = [
      '<notification id="child_request:agent-7:1700000000000" category="task" type="child_request" source_kind="subagent" source_id="agent-7">',
      'Title: Subagent info request',
      'Severity: info',
      'info: 目标终端宽度是否含侧栏展开态',
      'needs: independent verification',
      'artifacts: [src/a.ts, src/b.ts]',
      '</notification>',
    ].join('\n');

    const driver = await replayIntoDriver([
      message('user', [{ type: 'text', text: '继续侧栏的事' }]),
      message('assistant', [{ type: 'text', text: '好' }]),
      message('user', [{ type: 'text', text: notification }], {
        origin: { kind: 'system_trigger', name: 'child_request' },
      }),
    ]);

    const notice = driver.state.transcriptEntries.find(
      (entry) => entry.kind === 'status' && entry.renderMode === 'notice',
    );
    expect(notice?.content).toBe(
      t('transcript.child_request_anon', { type: t('transcript.child_request_type_info') }),
    );
    expect(notice?.detail).toContain('目标终端宽度是否含侧栏展开态');
    expect(notice?.detail).toContain('src/a.ts');
    // Replay carries the same interjection marker as the live path.
    expect(notice?.noticeMarkerColor).toBe(driver.state.theme.colors.warning);
    expect(driver.state.transcriptContainer.render(120).join('\n')).toContain('▸ ');
    // An injection is not user speech: it must never surface as a user row.
    expect(
      driver.state.transcriptEntries
        .filter((entry) => entry.kind === 'user')
        .map((entry) => entry.content),
    ).toEqual(['继续侧栏的事']);
    expect(driver.state.transcriptContainer.render(120).join('\n')).not.toContain('<notification');
  });

  it('paints a delivered request live exactly as replay reconstructs it', async () => {
    const notification = [
      '<notification id="child_request:agent-7:1700000000000" category="task" type="child_request" source_kind="subagent" source_id="agent-7">',
      'Title: Subagent info request',
      'Severity: info',
      'info: 目标终端宽度是否含侧栏展开态',
      'needs: independent verification',
      'artifacts: [src/a.ts, src/b.ts]',
      '</notification>',
    ].join('\n');

    const driver = await replayIntoDriver([
      message('user', [{ type: 'text', text: '继续侧栏的事' }]),
      message('user', [{ type: 'text', text: notification }], {
        origin: { kind: 'system_trigger', name: 'child_request' },
      }),
    ]);

    // The same request, now as the delivery frame the kernel emits live once
    // the request has actually landed in the parent's turn.
    driver.sessionEventHandler.handleEvent(
      {
        type: 'subagent.child_request',
        sessionId: 'ses-replay',
        agentId: 'main',
        subagentId: 'agent-7',
        subagentName: 'coder',
        requestType: 'info',
        message: '目标终端宽度是否含侧栏展开态',
        needs: 'independent verification',
        artifacts: ['src/a.ts', 'src/b.ts'],
      } as unknown as Event,
      vi.fn(),
    );

    const notices = driver.state.transcriptEntries.filter(
      (entry) => entry.kind === 'status' && entry.renderMode === 'notice',
    );
    // One row per delivered request. The body matches byte-for-byte; the title
    // is where the producers legitimately differ — the kernel names a live
    // child, while replay cannot recover a display name and stays name-less.
    expect(notices).toHaveLength(2);
    expect(notices[1]?.detail).toBe(notices[0]?.detail);
    expect(notices[1]?.content).toContain('coder');
    expect(notices[0]?.content).not.toContain('coder');
    expect(notices[1]?.noticeMarkerColor).toBe(driver.state.theme.colors.warning);
  });

  it('drops internal injections that carry no transcript meaning', async () => {
    const driver = await replayIntoDriver([
      message('user', [{ type: 'text', text: '真用户消息' }]),
      message('user', [{ type: 'text', text: '<system-reminder>\n记得用 TodoList\n</system-reminder>' }], {
        origin: { kind: 'system_trigger', name: 'todo_suggested' },
      }),
    ]);

    expect(
      driver.state.transcriptEntries
        .filter((entry) => entry.kind === 'user')
        .map((entry) => entry.content),
    ).toEqual(['真用户消息']);
  });
});

/**
 * Replayed background-agent identity (batch 5.4).
 *
 * `backgroundAgentMetadata` is keyed by *subagent id* — the identity the live
 * path stores at spawn and the one a later `subagent.completed` /
 * `subagent.failed` looks up. The task id is not a substitute: an entry filed
 * under it is invisible to that lookup, so after a resume the completion took
 * the foreground branch — it decremented the badge and routed the result into a
 * card that owns no run, while the notice named an id no event carries.
 */
describe('replayed background-agent identity', () => {
  it('keys replayed metadata by subagent id, not by task id', async () => {
    const driver = await replayIntoDriver([], {
      background: [backgroundTask('agent-bg1', 'Review long-running work', 'running', 'agent-7')],
    });

    expect(driver.sessionEventHandler.backgroundAgentMetadata.get('agent-7')).toEqual({
      agentId: 'agent-7',
      parentToolCallId: '',
      description: 'Review long-running work',
    });
    expect(driver.sessionEventHandler.backgroundAgentMetadata.has('agent-bg1')).toBe(false);
  });

  it('skips entries with no real subagent identity instead of inventing one', async () => {
    const driver = await replayIntoDriver([], {
      background: [
        // `registerAgentTask` falls back to `agentId = taskId` when its caller
        // passed no handle; that id names no subagent.
        backgroundTask('agent-fallback', 'no real owner', 'running', 'agent-fallback'),
        // A payload persisted before the id existed carries no agentId at all.
        backgroundTask('agent-legacy', 'legacy payload', 'running'),
        // A terminal task never seeds metadata: its completion already ran.
        backgroundTask('agent-done', 'already finished', 'completed', 'agent-9'),
        // Bash tasks are not subagents.
        backgroundTask('bash-plain', 'plain bash', 'running'),
      ],
    });

    expect(driver.sessionEventHandler.backgroundAgentMetadata.size).toBe(0);
  });

  it('reports a replayed agent notification under the owner id and clears its metadata', async () => {
    const driver = await replayIntoDriver(
      [
        message('user', [{ type: 'text', text: 'Nested agent was lost.' }], {
          origin: {
            kind: 'background_task',
            taskId: 'agent-bg9',
            status: 'lost',
            notificationId: 'task:agent-bg9:lost',
          },
        }),
      ],
      // Persisted mid-flight: the entry still reads `running` while the
      // notification record that follows says it was lost (reconcile
      // reclassification). The metadata seeded from this entry is what the
      // delete has to find — by owner id, not by task id.
      { background: [backgroundTask('agent-bg9', 'Nested run', 'running', 'agent-9')] },
    );

    const status = driver.state.transcriptEntries.find(
      (entry) => entry.backgroundAgentStatus !== undefined,
    );
    expect(status?.backgroundAgentStatus?.trackingId).toBe('agent-9');
    expect(driver.sessionEventHandler.backgroundAgentMetadata.has('agent-9')).toBe(false);
  });
});

describe('replayed block sealing at agent cards and delivered requests', () => {
  const stripAnsi = (line: string): string => line.replaceAll(/\u001B\[[0-9;]*m/g, '');

  it('seals the block above a replayed Agent card, so the next work starts below it', async () => {
    const driver = await replayIntoDriver([
      message('user', [{ type: 'text', text: 'run one agent' }]),
      message('assistant', [], { toolCalls: [toolCall('call_bash', 'Bash', { command: 'ls' })] }),
      message('tool', [{ type: 'text', text: 'file list' }], { toolCallId: 'call_bash' }),
      message('assistant', [], {
        toolCalls: [
          toolCall('call_agent', 'Agent', { description: 'inspect storage', subagent_type: 'explore' }),
        ],
      }),
      message('tool', [{ type: 'text', text: 'agent done' }], { toolCallId: 'call_agent' }),
      message('assistant', [], { toolCalls: [toolCall('call_read', 'Read', { file_path: 'a.ts' })] }),
      message('tool', [{ type: 'text', text: 'ok' }], { toolCallId: 'call_read' }),
    ]);

    const children = driver.state.transcriptContainer.children;
    const blocks = children.filter(
      (child): child is ActivityGroupComponent => child instanceof ActivityGroupComponent,
    );
    const card = children.find((child) => child instanceof ToolCallComponent);

    // The same shape the live session builds: the first Agent card cuts the
    // stretch of work in two, so the read after it opens a block below the card.
    expect(blocks).toHaveLength(2);
    expect(card).toBeInstanceOf(ToolCallComponent);
    expect(children.indexOf(blocks[0] as ActivityGroupComponent)).toBeLessThan(
      children.indexOf(card as ToolCallComponent),
    );
    expect(children.indexOf(card as ToolCallComponent)).toBeLessThan(
      children.indexOf(blocks[1] as ActivityGroupComponent),
    );
    expect(stripAnsi((blocks[0] as ActivityGroupComponent).render(120).join('\n'))).not.toContain('a.ts');
    expect(stripAnsi((blocks[1] as ActivityGroupComponent).render(120).join('\n'))).toContain('a.ts');
    expect(children.map((child) => child.render(120).join('\n')).join('\n')).toContain(
      'inspect storage',
    );
  });

  it('seals the block above a replayed child-request notice, so the next work starts below it', async () => {
    const notification = [
      '<notification id="child_request:agent-7:1700000000000" category="task" type="child_request" source_kind="subagent" source_id="agent-7">',
      'Title: Subagent info request',
      'Severity: info',
      'info: 目标终端宽度是否含侧栏展开态',
      'needs: independent verification',
      '</notification>',
    ].join('\n');

    const driver = await replayIntoDriver([
      message('user', [{ type: 'text', text: '继续侧栏的事' }]),
      message('assistant', [], { toolCalls: [toolCall('call_read', 'Read', { file_path: 'a.ts' })] }),
      message('tool', [{ type: 'text', text: 'ok' }], { toolCallId: 'call_read' }),
      message('user', [{ type: 'text', text: notification }], {
        origin: { kind: 'system_trigger', name: 'child_request' },
      }),
      message('assistant', [], {
        toolCalls: [toolCall('call_bash', 'Bash', { command: 'ls' })],
      }),
      message('tool', [{ type: 'text', text: 'file list' }], { toolCallId: 'call_bash' }),
    ]);

    const children = driver.state.transcriptContainer.children;
    const blocks = children.filter(
      (child): child is ActivityGroupComponent => child instanceof ActivityGroupComponent,
    );
    const notice = children.find((child) => child instanceof NoticeMessageComponent);

    // Live and replay show one shape: the notice cuts the stretch of work in
    // two, so the bash call after it opens a block below the notice.
    expect(blocks).toHaveLength(2);
    expect(notice).toBeInstanceOf(NoticeMessageComponent);
    expect(children.indexOf(blocks[0] as ActivityGroupComponent)).toBeLessThan(
      children.indexOf(notice as NoticeMessageComponent),
    );
    expect(children.indexOf(notice as NoticeMessageComponent)).toBeLessThan(
      children.indexOf(blocks[1] as ActivityGroupComponent),
    );
    expect(stripAnsi((blocks[0] as ActivityGroupComponent).render(120).join('\n'))).not.toContain('Bash');
    expect(stripAnsi((blocks[1] as ActivityGroupComponent).render(120).join('\n'))).toContain('Bash');
  });
});

describe('replayed foreground→background handoff', () => {
  const stripAnsi = (line: string): string => line.replaceAll(/\u001B\[[0-9;]*m/g, '');

  it('keeps a handed-off agent card on 后台运行 instead of an ordinary finish', async () => {
    const driver = await replayIntoDriver([
      message('user', [{ type: 'text', text: 'run an agent' }]),
      message('assistant', [], {
        toolCalls: [
          toolCall('call_agent', 'Agent', { description: 'inspect storage', subagent_type: 'explore' }),
        ],
      }),
      message(
        'tool',
        [
          {
            type: 'text',
            text: [
              'task_id: agent-handoff1',
              'status: backgrounded',
              'agent_id: agent-1',
              'automatic_notification: true',
            ].join('\n'),
          },
        ],
        { toolCallId: 'call_agent' },
      ),
    ]);

    const card = driver.state.transcriptContainer.children.find(
      (child) => child instanceof ToolCallComponent,
    );
    expect(card).toBeInstanceOf(ToolCallComponent);
    const out = (card as ToolCallComponent)
      .render(120)
      .map(stripAnsi)
      .join('\n');
    expect(out).toContain('后台运行');
    expect(out).not.toContain('已完成');
  });

  it('keeps the register-failure handoff on 后台运行: the result line is the only signal', async () => {
    const driver = await replayIntoDriver([
      message('user', [{ type: 'text', text: 'run an agent' }]),
      message('assistant', [], {
        toolCalls: [
          toolCall('call_agent', 'Agent', { description: 'inspect storage', subagent_type: 'explore' }),
        ],
      }),
      message(
        'tool',
        [
          {
            type: 'text',
            text: [
              'agent_id: agent-1',
              'actual_subagent_type: explore',
              'status: backgrounded',
              '',
              'warning: the subagent requested input and could not register a background task: running-task limit reached',
            ].join('\n'),
          },
        ],
        { toolCallId: 'call_agent' },
      ),
    ]);

    const card = driver.state.transcriptContainer.children.find(
      (child) => child instanceof ToolCallComponent,
    );
    expect(card).toBeInstanceOf(ToolCallComponent);
    expect((card as ToolCallComponent).getSubagentSnapshot().phase).toBe('backgrounded');
    const out = (card as ToolCallComponent)
      .render(120)
      .map(stripAnsi)
      .join('\n');
    expect(out).toContain('后台运行');
    expect(out).not.toContain('已完成');
  });

  it('leaves a completed card alone when the phrase only appears inside prose', async () => {
    const driver = await replayIntoDriver([
      message('user', [{ type: 'text', text: 'run an agent' }]),
      message('assistant', [], {
        toolCalls: [
          toolCall('call_agent', 'Agent', { description: 'inspect storage', subagent_type: 'explore' }),
        ],
      }),
      message(
        'tool',
        [
          {
            type: 'text',
            text: [
              'agent_id: agent-2',
              'actual_subagent_type: explore',
              'status: completed',
              '',
              'summary: the earlier run resumed after status: backgrounded was reported.',
            ].join('\n'),
          },
        ],
        { toolCallId: 'call_agent' },
      ),
    ]);

    const card = driver.state.transcriptContainer.children.find(
      (child) => child instanceof ToolCallComponent,
    );
    expect(card).toBeInstanceOf(ToolCallComponent);
    expect((card as ToolCallComponent).getSubagentSnapshot().phase).toBe('done');
    const out = (card as ToolCallComponent)
      .render(120)
      .map(stripAnsi)
      .join('\n');
    expect(out).not.toContain('后台运行');
  });
});
