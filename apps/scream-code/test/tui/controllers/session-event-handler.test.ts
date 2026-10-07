import { describe, expect, it, vi } from 'vitest';

import type { Event, Session } from '@scream-code/scream-code-sdk';
import {
  SessionEventHandler,
  isMainAgentStatusEvent,
  type SessionEventHost,
} from '#/tui/controllers/session-event-handler';
import type { StreamingUIController } from '#/tui/controllers/streaming-ui';
import type { TasksBrowserController } from '#/tui/controllers/tasks-browser';
import type { TUIState } from '#/tui/tui-state';
import type { TranscriptEntry } from '#/tui/types';
import {
  buildAgentRows,
  createSubagentInstanceInfo,
  MAX_RECENT_SUBAGENT_INSTANCES,
  withSubagentInstanceEnded,
} from '#/tui/utils/subagent-instances';

function createMockHost(): SessionEventHost {
  const streamingUI = {
    setStep: vi.fn(),
    setTurnId: vi.fn(),
    resetLiveText: vi.fn(),
    resetToolUi: vi.fn(),
    endActivityGroup: vi.fn(),
    flushNow: vi.fn(),
    flushPendingApprovals: vi.fn(),
    finalizeLiveTextBuffers: vi.fn(),
    finalizeAssistantStream: vi.fn(),
    finalizeTurn: vi.fn(),
    registerToolCall: vi.fn(),
    completeToolResult: vi.fn(),
    scheduleFlush: vi.fn(),
    appendAssistantDelta: vi.fn(),
    appendThinkingDelta: vi.fn(),
    hasThinkingDraft: vi.fn().mockReturnValue(false),
    flushThinkingToTranscript: vi.fn(),
    getTurnContext: vi.fn().mockReturnValue({ turnId: '1' }),
    setTodoList: vi.fn(),
    endCompaction: vi.fn(),
    cancelCompaction: vi.fn(),
    markStepTruncated: vi.fn().mockReturnValue(0),
    getToolComponent: vi.fn().mockReturnValue(undefined),
    getActiveToolCall: vi.fn().mockReturnValue(undefined),
    onToolCallStart: vi.fn(),
    hasActiveTurn: vi.fn().mockReturnValue(false),
    hasPendingToolCalls: vi.fn().mockReturnValue(false),
    accumulateToolCallDelta: vi.fn(),
  } as unknown as StreamingUIController;

  const tasksBrowserController = {
    refreshOutputViewer: vi.fn(),
    repaint: vi.fn(),
  } as unknown as TasksBrowserController;

  const transcriptEntries: TranscriptEntry[] = [];

  const state = {
    appState: {
      sessionId: 'ses-test',
      streamingPhase: 'idle',
      streamingStartTime: 0,
      isCompacting: false,
      goal: null,
      goalActive: false,
      sessionTitle: 'Test Session',
      subagentUsage: {},
      sessionApiCalls: 0,
    },
    livePane: {
      mode: 'idle',
      pendingApproval: null,
      pendingQuestion: null,
      viewer: null,
    },
    queuedMessages: [],
    transcriptEntries,
    theme: {
      colors: {
        error: 'red',
        warning: 'yellow',
        textMuted: 'gray',
      },
    },
    todoPanel: {
      getTodos: vi.fn().mockReturnValue([]),
    },
    transcriptContainer: {
      children: [],
    },
  } as unknown as TUIState;

  const host: SessionEventHost = {
    state,
    session: undefined,
    aborted: false,
    sessionEventUnsubscribe: undefined,
    streamingUI,
    deferUserMessages: false,
    tasksBrowserController,
    requireSession: vi.fn(),
    setAppState: vi.fn((patch) => {
      Object.assign(state.appState, patch);
    }),
    patchLivePane: vi.fn((patch) => {
      Object.assign(state.livePane, patch);
    }),
    resetLivePane: vi.fn(),
    showError: vi.fn(),
    showStatus: vi.fn(),
    showNotice: vi.fn(),
    appendTranscriptEntry: vi.fn((entry) => {
      transcriptEntries.push(entry);
    }),
    sendQueuedMessage: vi.fn(),
    sendNormalUserInput: vi.fn(),
    shiftQueuedMessage: vi.fn(),
    updateQueueDisplay: vi.fn(),
    markMemoryExtracted: vi.fn(),
  };

  return host;
}

function baseEvent(type: string): Record<string, unknown> {
  return {
    type,
    sessionId: 'ses-test',
    agentId: 'main',
  };
}

describe('SessionEventHandler', () => {
  it('shows errors and status warnings', () => {
    const host = createMockHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(
      {
        ...baseEvent('error'),
        turnId: 1,
        code: 'E_TEST',
        message: 'Something broke',
      } as unknown as Event,
      vi.fn(),
    );

    expect(host.showError).toHaveBeenCalledWith('[E_TEST] Something broke');

    handler.handleEvent(
      {
        ...baseEvent('warning'),
        turnId: 1,
        message: 'Heads up',
      } as unknown as Event,
      vi.fn(),
    );

    expect(host.showStatus).toHaveBeenCalledWith('警告： Heads up', 'yellow');
  });

  it('transitions through a simple assistant turn', () => {
    const host = createMockHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(
      {
        ...baseEvent('turn.started'),
        turnId: 1,
      } as unknown as Event,
      vi.fn(),
    );

    expect(host.streamingUI.setStep).toHaveBeenCalledWith(0);
    expect(host.patchLivePane).toHaveBeenCalledWith({
      pendingApproval: null,
      pendingQuestion: null,
    });
    expect(host.setAppState).toHaveBeenCalledWith({
      streamingPhase: 'waiting',
    });

    handler.handleEvent(
      {
        ...baseEvent('assistant.delta'),
        turnId: 1,
        delta: { type: 'text', text: 'Hello' },
      } as unknown as Event,
      vi.fn(),
    );

    expect(host.streamingUI.appendAssistantDelta).toHaveBeenCalledWith({
      type: 'text',
      text: 'Hello',
    });
    expect(host.setAppState).toHaveBeenLastCalledWith({
      streamingPhase: 'composing',
    });

    handler.handleEvent(
      {
        ...baseEvent('turn.ended'),
        turnId: 1,
        reason: 'completed',
      } as unknown as Event,
      vi.fn(),
    );

    expect(host.streamingUI.finalizeTurn).toHaveBeenCalled();
    expect(host.streamingUI.resetToolUi).toHaveBeenCalled();
  });

  it('resets live text and tool UI on step retrying', () => {
    const host = createMockHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(
      {
        ...baseEvent('turn.step.retrying'),
        turnId: 1,
        attempt: 1,
        nextAttempt: 2,
      } as unknown as Event,
      vi.fn(),
    );

    expect(host.streamingUI.resetLiveText).toHaveBeenCalled();
    expect(host.streamingUI.resetToolUi).toHaveBeenCalled();
    expect(host.setAppState).toHaveBeenCalledWith({ reconnectAttempt: 2, sessionApiCalls: 1 });
  });

  it('settles approvals still waiting for a row when the step completes', () => {
    const host = createMockHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(
      { ...baseEvent('turn.step.completed'), turnId: 1 } as unknown as Event,
      vi.fn(),
    );

    // The end of a step is the last chance for an outcome whose call never
    // joined a block: it keeps its own row from here on.
    expect(host.streamingUI.flushPendingApprovals).toHaveBeenCalledTimes(1);
  });

  it('counts completed steps and retried attempts as API calls', () => {
    const host = createMockHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(
      { ...baseEvent('turn.step.completed'), turnId: 1 } as unknown as Event,
      vi.fn(),
    );
    handler.handleEvent(
      {
        ...baseEvent('turn.step.retrying'),
        turnId: 1,
        attempt: 1,
        nextAttempt: 2,
      } as unknown as Event,
      vi.fn(),
    );
    handler.handleEvent(
      { ...baseEvent('turn.step.completed'), turnId: 1 } as unknown as Event,
      vi.fn(),
    );

    // Two successful steps plus the attempt that failed and was retried.
    expect(host.state.appState.sessionApiCalls).toBe(3);
  });

  it('auto-drains queued messages into a boundary steer on step completed', () => {
    const host = createMockHost();
    const steer = vi.fn().mockResolvedValue(undefined);
    host.session = { steer } as unknown as Session;
    host.state.queuedMessages = [
      { text: 'first queued', agentId: 'main' },
      { text: 'second queued', agentId: 'main' },
    ];
    const handler = new SessionEventHandler(host);

    handler.handleEvent(
      {
        ...baseEvent('turn.step.completed'),
        turnId: 1,
        step: 1,
        finishReason: 'tool_use',
      } as unknown as Event,
      vi.fn(),
    );

    expect(host.state.queuedMessages).toEqual([]);
    expect(host.updateQueueDisplay).toHaveBeenCalled();
    expect(steer).toHaveBeenCalledTimes(2);
    expect(steer).toHaveBeenNthCalledWith(1, 'first queued', { interrupt: false });
    expect(steer).toHaveBeenNthCalledWith(2, 'second queued', { interrupt: false });
    // Each drained message also lands in the transcript as a user entry.
    const transcript = (host.appendTranscriptEntry as ReturnType<typeof vi.fn>).mock.calls;
    expect(transcript).toHaveLength(2);
    expect(transcript[0]?.[0]).toMatchObject({ kind: 'user', content: 'first queued' });
  });

  it('does not drain the queue while compacting', () => {
    const host = createMockHost();
    const steer = vi.fn().mockResolvedValue(undefined);
    host.session = { steer } as unknown as Session;
    host.state.appState.isCompacting = true;
    host.state.queuedMessages = [{ text: 'wait for compaction', agentId: 'main' }];
    const handler = new SessionEventHandler(host);

    handler.handleEvent(
      {
        ...baseEvent('turn.step.completed'),
        turnId: 1,
        step: 1,
        finishReason: 'tool_use',
      } as unknown as Event,
      vi.fn(),
    );

    expect(steer).not.toHaveBeenCalled();
    expect(host.state.queuedMessages).toHaveLength(1);
  });

  it('does not drain the queue while user messages are deferred (/init, make-skill)', () => {
    const host = createMockHost();
    const steer = vi.fn().mockResolvedValue(undefined);
    host.session = { steer } as unknown as Session;
    (host as { deferUserMessages: boolean }).deferUserMessages = true;
    host.state.queuedMessages = [{ text: 'do not inject into init', agentId: 'main' }];
    const handler = new SessionEventHandler(host);

    handler.handleEvent(
      {
        ...baseEvent('turn.step.completed'),
        turnId: 1,
        step: 1,
        finishReason: 'tool_use',
      } as unknown as Event,
      vi.fn(),
    );

    expect(steer).not.toHaveBeenCalled();
    expect(host.state.queuedMessages).toHaveLength(1);
  });

  it('updates the todo panel only from core todo.updated snapshots', () => {
    const host = createMockHost();
    const handler = new SessionEventHandler(host);
    const setTodoList = vi.mocked(host.streamingUI.setTodoList);
    const completeToolResult = vi.mocked(host.streamingUI.completeToolResult);
    completeToolResult.mockReturnValue({
      id: 'call_todo',
      name: 'TodoList',
      args: { todos: [{ title: 'stale tool args', status: 'pending' }] },
    });

    handler.handleEvent(
      {
        ...baseEvent('tool.result'),
        turnId: 1,
        toolCallId: 'call_todo',
        output: 'Todo list updated.',
        isError: false,
      } as unknown as Event,
      vi.fn(),
    );
    expect(setTodoList).not.toHaveBeenCalled();

    handler.handleEvent(
      {
        ...baseEvent('todo.updated'),
        todos: [
          { title: 'core snapshot', status: 'in_progress', phase: 'Core' },
          { title: 'next step', status: 'pending', phase: 'TUI' },
        ],
      } as unknown as Event,
      vi.fn(),
    );

    expect(setTodoList).toHaveBeenCalledTimes(1);
    expect(setTodoList).toHaveBeenCalledWith([
      { title: 'core snapshot', status: 'in_progress', phase: 'Core' },
      { title: 'next step', status: 'pending', phase: 'TUI' },
    ]);
  });

  it('accumulates subagent token usage by profile name', () => {
    const host = createMockHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(
      {
        ...baseEvent('subagent.spawned'),
        subagentId: 'sub-1',
        subagentName: 'coder',
        parentToolCallId: 'tc-1',
        runInBackground: false,
      } as unknown as Event,
      vi.fn(),
    );

    handler.handleEvent(
      {
        ...baseEvent('subagent.completed'),
        subagentId: 'sub-1',
        parentToolCallId: 'tc-1',
        resultSummary: 'done',
        usage: { inputOther: 100, inputCacheRead: 0, inputCacheCreation: 0, output: 50 },
      } as unknown as Event,
      vi.fn(),
    );

    expect(host.setAppState).toHaveBeenLastCalledWith({
      subagentUsage: {
        coder: { inputOther: 100, inputCacheRead: 0, inputCacheCreation: 0, output: 50 },
      },
    });
  });

  it('merges usage when the same profile runs multiple times', () => {
    const host = createMockHost();
    const handler = new SessionEventHandler(host);

    for (const id of ['sub-1', 'sub-2']) {
      handler.handleEvent(
        {
          ...baseEvent('subagent.spawned'),
          subagentId: id,
          subagentName: 'reviewer',
          parentToolCallId: 'tc-1',
          runInBackground: false,
        } as unknown as Event,
        vi.fn(),
      );
      handler.handleEvent(
        {
          ...baseEvent('subagent.completed'),
          subagentId: id,
          parentToolCallId: 'tc-1',
          resultSummary: 'done',
          usage: { inputOther: 10, inputCacheRead: 5, inputCacheCreation: 0, output: 20 },
        } as unknown as Event,
        vi.fn(),
      );
    }

    expect(host.setAppState).toHaveBeenLastCalledWith({
      subagentUsage: {
        reviewer: { inputOther: 20, inputCacheRead: 10, inputCacheCreation: 0, output: 40 },
      },
    });
  });

  it('records usage from failed subagents', () => {
    const host = createMockHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(
      {
        ...baseEvent('subagent.spawned'),
        subagentId: 'sub-1',
        subagentName: 'coder',
        parentToolCallId: 'tc-1',
        runInBackground: false,
      } as unknown as Event,
      vi.fn(),
    );

    handler.handleEvent(
      {
        ...baseEvent('subagent.failed'),
        subagentId: 'sub-1',
        parentToolCallId: 'tc-1',
        error: 'boom',
        usage: { inputOther: 30, inputCacheRead: 0, inputCacheCreation: 0, output: 10 },
      } as unknown as Event,
      vi.fn(),
    );

    expect(host.setAppState).toHaveBeenLastCalledWith({
      subagentUsage: {
        coder: { inputOther: 30, inputCacheRead: 0, inputCacheCreation: 0, output: 10 },
      },
    });
  });

  it('surfaces a background-task completion notice from a custom tool.progress event', () => {
    const host = createMockHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(
      {
        ...baseEvent('tool.progress'),
        turnId: 1,
        toolCallId: 'call_bash_1',
        update: {
          kind: 'custom',
          customKind: 'background.task.terminated',
          customData: { id: 'abc12345', command: 'sleep 70', exitCode: 0 },
        },
      } as unknown as Event,
      vi.fn(),
    );

    expect(host.showNotice).toHaveBeenCalledTimes(1);
    expect(host.showNotice).toHaveBeenCalledWith(expect.stringContaining('abc12345'));

    handler.handleEvent(
      {
        ...baseEvent('tool.progress'),
        turnId: 1,
        toolCallId: 'call_bash_2',
        update: {
          kind: 'custom',
          customKind: 'background.task.terminated',
          customData: { id: 'def67890', command: 'make build', exitCode: 2 },
        },
      } as unknown as Event,
      vi.fn(),
    );

    expect(host.showNotice).toHaveBeenCalledTimes(2);
    expect(host.showNotice).toHaveBeenLastCalledWith(expect.stringContaining('退出码 2'));
  });

  it('forwards stdout/stderr tool progress to the live output renderer', () => {
    const host = createMockHost();
    const appendLiveOutput = vi.fn();
    const appendProgress = vi.fn();
    (host.streamingUI.getToolComponent as ReturnType<typeof vi.fn>).mockReturnValue({
      appendLiveOutput,
      appendProgress,
    });
    const handler = new SessionEventHandler(host);

    handler.handleEvent(
      {
        ...baseEvent('tool.progress'),
        turnId: 1,
        toolCallId: 'call_bash_3',
        update: { kind: 'stdout', text: 'building...' },
      } as unknown as Event,
      vi.fn(),
    );
    expect(appendLiveOutput).toHaveBeenCalledWith('building...');
    expect(appendProgress).not.toHaveBeenCalled();

    handler.handleEvent(
      {
        ...baseEvent('tool.progress'),
        turnId: 1,
        toolCallId: 'call_bash_4',
        update: { kind: 'status', text: 'working' },
      } as unknown as Event,
      vi.fn(),
    );
    expect(appendProgress).toHaveBeenCalledWith('working');
    expect(appendLiveOutput).toHaveBeenCalledTimes(1);
  });

  it('marks the sidebar slot as requesting when a subagent contacts the parent', () => {
    const host = createMockHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(
      {
        type: 'subagent.spawned',
        sessionId: 'ses-test',
        agentId: 'agent-7',
        subagentId: 'agent-7',
        subagentName: 'coder',
        description: 'do work',
      } as unknown as Event,
      vi.fn(),
    );
    const coderStatus = () =>
      handler.getSubagentSlots().find((slot) => slot.type === 'coder')?.status;
    expect(coderStatus()).toBe('working');

    // Ordinary tool work keeps reading as working…
    handler.handleEvent(
      { ...baseEvent('tool.call.started'), agentId: 'agent-7', name: 'Read' } as unknown as Event,
      vi.fn(),
    );
    expect(coderStatus()).toBe('working');

    // …but asking the parent raises the transient help marker instead.
    handler.handleEvent(
      {
        ...baseEvent('tool.call.started'),
        agentId: 'agent-7',
        name: 'ContactParent',
      } as unknown as Event,
      vi.fn(),
    );
    expect(coderStatus()).toBe('requesting');
  });

  it('cuts into the transcript when a subagent asks the parent', () => {
    const host = createMockHost();
    const handler = new SessionEventHandler(host);
    const appended = () =>
      (host.appendTranscriptEntry as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0]);

    // Spawn events are emitted by the parent agent, so they carry the main
    // agentId and reach handleSubagentSpawned, which registers the name.
    handler.handleEvent(
      {
        type: 'subagent.spawned',
        sessionId: 'ses-test',
        agentId: 'main',
        subagentId: 'agent-7',
        subagentName: 'coder',
        description: 'do work',
        parentToolCallId: 'call-agent-7',
      } as unknown as Event,
      vi.fn(),
    );
    handler.handleEvent(
      {
        ...baseEvent('tool.call.started'),
        agentId: 'agent-7',
        name: 'ContactParent',
        args: { request_type: 'info', message: '目标终端宽度是否含侧栏展开态' },
      } as unknown as Event,
      vi.fn(),
    );

    expect(appended()).toHaveLength(1);
    expect(appended()[0]).toMatchObject({
      kind: 'status',
      renderMode: 'notice',
      // The turn stamp keeps the row attributable for /revoke, same as replay.
      turnId: '1',
      content: expect.stringContaining('coder'),
      detail: expect.stringContaining('目标终端宽度是否含侧栏展开态'),
      noticeMarkerColor: host.state.theme.colors.warning,
    });

    // Ordinary tool work stays out of the transcript.
    handler.handleEvent(
      { ...baseEvent('tool.call.started'), agentId: 'agent-7', name: 'Read', args: { path: 'x' } } as unknown as Event,
      vi.fn(),
    );
    expect(appended()).toHaveLength(1);
  });

  it('labels an unnamed requester and never paints an empty notice', () => {
    const host = createMockHost();
    const handler = new SessionEventHandler(host);
    const appended = () =>
      (host.appendTranscriptEntry as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0]);

    // A child the handler has never seen still reached the parent, so the
    // notice must appear — just without a name to attribute.
    handler.handleEvent(
      {
        ...baseEvent('tool.call.started'),
        agentId: 'agent-9',
        name: 'ContactParent',
        args: { request_type: 'escalate', message: '需要人工决策' },
      } as unknown as Event,
      vi.fn(),
    );
    expect(appended()).toHaveLength(1);
    expect(appended()[0]?.content).not.toContain('agent-9');

    // A malformed call carries no request text: render nothing at all.
    handler.handleEvent(
      { ...baseEvent('tool.call.started'), agentId: 'agent-9', name: 'ContactParent' } as unknown as Event,
      vi.fn(),
    );
    expect(appended()).toHaveLength(1);
  });

  describe('skill_candidate', () => {
    function makeHandlerWithSession() {
      const host = createMockHost();
      const prompt = vi.fn().mockResolvedValue(undefined);
      host.session = { prompt } as unknown as Session;
      const handler = new SessionEventHandler(host);
      return { handler, prompt, host };
    }

    function candidateEvent(name: string, purpose = 'test purpose'): Event {
      return {
        type: 'skill_candidate',
        sessionId: 'ses-test',
        agentId: 'main',
        candidate: { name, purpose, evidence: 'evidence' },
      } as unknown as Event;
    }

    it('prompts the session with an AskUserQuestion request when a candidate is detected', () => {
      const { handler, prompt } = makeHandlerWithSession();
      handler.handleEvent(candidateEvent('weather-report-doc'), vi.fn());
      expect(prompt).toHaveBeenCalledTimes(1);
      const request = String(prompt.mock.calls[0]![0]);
      expect(request).toContain('weather-report-doc');
      expect(request).toContain('AskUserQuestion');
      expect(request).toContain('生成');
    });

    it('deduplicates candidates by name within a session', () => {
      const { handler, prompt } = makeHandlerWithSession();
      handler.handleEvent(candidateEvent('build-flow'), vi.fn());
      handler.handleEvent(candidateEvent('build-flow'), vi.fn());
      expect(prompt).toHaveBeenCalledTimes(1);
    });

    it('is a no-op when there is no active session', () => {
      const host = createMockHost();
      expect(host.session).toBeUndefined();
      const handler = new SessionEventHandler(host);
      expect(() => handler.handleEvent(candidateEvent('x'), vi.fn())).not.toThrow();
    });

    it('does not swallow the candidate when the session is unavailable', () => {
      // The dedup set must only be written once the candidate can actually be
      // surfaced — otherwise a session-availability race would permanently
      // drop the candidate.
      const host = createMockHost();
      expect(host.session).toBeUndefined();
      const handler = new SessionEventHandler(host);
      handler.handleEvent(candidateEvent('deferred-flow'), vi.fn());

      // Later, with a session available, the same candidate must still prompt.
      const prompt = vi.fn().mockResolvedValue(undefined);
      host.session = { prompt } as unknown as Session;
      handler.handleEvent(candidateEvent('deferred-flow'), vi.fn());
      expect(prompt).toHaveBeenCalledTimes(1);
    });

    it('is a no-op for an empty candidate name', () => {
      const { handler, prompt } = makeHandlerWithSession();
      handler.handleEvent(candidateEvent(''), vi.fn());
      expect(prompt).not.toHaveBeenCalled();
    });

    it('survives a prompt rejection (no unhandled rejection)', async () => {
      const { handler, prompt } = makeHandlerWithSession();
      prompt.mockRejectedValueOnce(new Error('session closed'));
      handler.handleEvent(candidateEvent('x'), vi.fn());
      await vi.waitFor(() => expect(prompt).toHaveBeenCalled());
      // The .catch() swallows the rejection; the test simply must not throw.
    });

    it('queues the candidate while a turn is active and prompts at turn end', () => {
      const { handler, prompt, host } = makeHandlerWithSession();
      vi.mocked(host.streamingUI.hasActiveTurn).mockReturnValue(true);
      handler.handleEvent(candidateEvent('queued-flow'), vi.fn());
      // Not prompted while the turn is still streaming.
      expect(prompt).not.toHaveBeenCalled();

      // Turn ends: the queued candidate is flushed and prompted. Note the
      // flush runs on turn.ended itself (handleEvent re-set _currentTurnId
      // from the event before dispatch, so hasActiveTurn() is true here too —
      // the queue must not gate on it).
      handler.handleEvent(
        { type: 'turn.ended', sessionId: 'ses-test', agentId: 'main', turnId: 't1', reason: 'completed' } as unknown as Event,
        vi.fn(),
      );
      expect(prompt).toHaveBeenCalledTimes(1);
      expect(String(prompt.mock.calls[0]![0])).toContain('queued-flow');
    });

    it('flushes all queued candidates at turn end', () => {
      const { handler, prompt, host } = makeHandlerWithSession();
      vi.mocked(host.streamingUI.hasActiveTurn).mockReturnValue(true);
      handler.handleEvent(candidateEvent('flow-a'), vi.fn());
      handler.handleEvent(candidateEvent('flow-b'), vi.fn());
      expect(prompt).not.toHaveBeenCalled();

      handler.handleEvent(
        { type: 'turn.ended', sessionId: 'ses-test', agentId: 'main', turnId: 't1', reason: 'completed' } as unknown as Event,
        vi.fn(),
      );
      expect(prompt).toHaveBeenCalledTimes(2);
    });

    it('flushes queued candidates even when hasActiveTurn is still true at turn.ended', () => {
      // Regression: handleEvent re-sets _currentTurnId from the turn.ended
      // event before dispatch, so hasActiveTurn() is true during turn-end
      // handling. The flush must not gate on it or the queue never drains.
      const { handler, prompt, host } = makeHandlerWithSession();
      vi.mocked(host.streamingUI.hasActiveTurn).mockReturnValue(true);
      handler.handleEvent(candidateEvent('drain-me'), vi.fn());
      expect(prompt).not.toHaveBeenCalled();

      // Keep hasActiveTurn() true the whole time — as in production.
      handler.handleEvent(
        { type: 'turn.ended', sessionId: 'ses-test', agentId: 'main', turnId: 't1', reason: 'completed' } as unknown as Event,
        vi.fn(),
      );
      expect(prompt).toHaveBeenCalledTimes(1);
      expect(String(prompt.mock.calls[0]![0])).toContain('drain-me');
    });

    it('defers the flush when the user has queued messages, to protect them from agent_busy', () => {
      const { handler, prompt, host } = makeHandlerWithSession();
      // Queue a user message awaiting send (e.g. typed while the turn streamed).
      host.state.queuedMessages = [{ text: 'queued user message', agentId: 'main' }];
      vi.mocked(host.streamingUI.hasActiveTurn).mockReturnValue(true);
      handler.handleEvent(candidateEvent('queued-flow'), vi.fn());
      expect(prompt).not.toHaveBeenCalled();

      // Turn ends while a user message is still queued: the candidate must NOT
      // be prompted now (its prompt would race ahead of the queued message via
      // setTimeout(0) and the user message would be dropped as agent_busy).
      handler.handleEvent(
        { type: 'turn.ended', sessionId: 'ses-test', agentId: 'main', turnId: 't1', reason: 'completed' } as unknown as Event,
        vi.fn(),
      );
      expect(prompt).not.toHaveBeenCalled();

      // The queued user message is sent; once that turn ends and the queue is
      // empty, the deferred candidate flushes.
      host.state.queuedMessages = [];
      handler.handleEvent(
        { type: 'turn.ended', sessionId: 'ses-test', agentId: 'main', turnId: 't2', reason: 'completed' } as unknown as Event,
        vi.fn(),
      );
      expect(prompt).toHaveBeenCalledTimes(1);
      expect(String(prompt.mock.calls[0]![0])).toContain('queued-flow');
    });

    it('drops queued candidates when the runtime state resets (session switch)', () => {
      const { handler, prompt, host } = makeHandlerWithSession();
      vi.mocked(host.streamingUI.hasActiveTurn).mockReturnValue(true);
      handler.handleEvent(candidateEvent('stale-session-flow'), vi.fn());
      expect(prompt).not.toHaveBeenCalled();

      // Session switch clears the queue and the dedupe set.
      handler.resetRuntimeState();
      handler.handleEvent(
        { type: 'turn.ended', sessionId: 'ses-test', agentId: 'main', turnId: 't1', reason: 'completed' } as unknown as Event,
        vi.fn(),
      );
      expect(prompt).not.toHaveBeenCalled();

      // A fresh candidate in the new session still prompts immediately.
      vi.mocked(host.streamingUI.hasActiveTurn).mockReturnValue(false);
      handler.handleEvent(candidateEvent('new-session-flow'), vi.fn());
      expect(prompt).toHaveBeenCalledTimes(1);
      expect(String(prompt.mock.calls[0]![0])).toContain('new-session-flow');
    });
  });

  it('averages measured first-token latency for the sidebar Hub provider row', () => {
    const host = createMockHost();
    const handler = new SessionEventHandler(host);

    expect(handler.getProviderLatency()).toEqual({ ms: undefined, sampledAt: undefined });

    for (const latency of [100, 200, 300]) {
      handler.handleEvent(
        {
          ...baseEvent('turn.step.completed'),
          turnId: 1,
          llmFirstTokenLatencyMs: latency,
        } as unknown as Event,
        vi.fn(),
      );
    }
    expect(handler.getProviderLatency().ms).toBe(200);

    // The window slides: the oldest reading drops out.
    handler.handleEvent(
      {
        ...baseEvent('turn.step.completed'),
        turnId: 1,
        llmFirstTokenLatencyMs: 400,
      } as unknown as Event,
      vi.fn(),
    );
    expect(handler.getProviderLatency().ms).toBe(300);
  });

  it('separates provider latency by model and ignores unmeasured steps', () => {
    const host = createMockHost();
    const handler = new SessionEventHandler(host);
    host.setAppState({ model: 'provider-a' });
    for (const latency of [100, 200]) {
      handler.handleEvent(
        {
          ...baseEvent('turn.step.completed'),
          turnId: 1,
          llmFirstTokenLatencyMs: latency,
        } as unknown as Event,
        vi.fn(),
      );
    }
    expect(handler.getProviderLatency().ms).toBe(150);

    // A different provider is a different network path: never average across it.
    host.setAppState({ model: 'provider-b' });
    handler.handleEvent(
      {
        ...baseEvent('turn.step.completed'),
        turnId: 1,
        llmFirstTokenLatencyMs: 900,
      } as unknown as Event,
      vi.fn(),
    );
    expect(handler.getProviderLatency().ms).toBe(900);

    // A step that never reported a latency must not read as an instant reply.
    handler.handleEvent(
      { ...baseEvent('turn.step.completed'), turnId: 1 } as unknown as Event,
      vi.fn(),
    );
    expect(handler.getProviderLatency().ms).toBe(900);
  });

  it('drops the provider latency the moment the model changes, without waiting for a step', () => {
    const host = createMockHost();
    const handler = new SessionEventHandler(host);
    host.setAppState({ model: 'provider-a' });
    handler.handleEvent(
      { ...baseEvent('turn.step.completed'), turnId: 1, llmFirstTokenLatencyMs: 120 } as unknown as Event,
      vi.fn(),
    );
    expect(handler.getProviderLatency().ms).toBe(120);

    // A different provider is a different network path. The old reading must not
    // stay on screen until the next completed step (or the stale budget elapses).
    host.setAppState({ model: 'provider-b' });
    expect(handler.getProviderLatency()).toEqual({ ms: undefined, sampledAt: undefined });
  });
});

describe('SessionEventHandler — phase convergence', () => {
  /** Mirrors the wire shape: ErrorEvent = ScreamErrorPayload + type, i.e. no
   *  top-level turnId (packages/agent-core/src/rpc/events.ts:86-88). */
  function errorEvent(code = 'turn.agent_busy') {
    return {
      ...baseEvent('error'),
      code,
      message: 'Cannot launch a new turn while another turn is active',
    } as unknown as Event;
  }

  it('collapses a phase that no turn ever claimed (prompt refused before turn.started)', () => {
    const host = createMockHost();
    const handler = new SessionEventHandler(host);
    // beginSessionRequest() optimistically marks the request as running.
    host.state.appState.streamingPhase = 'waiting';
    // No turn is live: the prompt was refused (turn.agent_busy) without a
    // turn.started, so no turn.ended will ever arrive to settle it.
    vi.mocked(host.streamingUI.hasActiveTurn).mockReturnValue(false);

    handler.handleEvent(errorEvent(), vi.fn());

    expect(host.setAppState).toHaveBeenCalledWith({ streamingPhase: 'idle' });
    expect(host.resetLivePane).toHaveBeenCalled();
    expect(host.showError).toHaveBeenCalledWith(
      '[turn.agent_busy] Cannot launch a new turn while another turn is active',
    );
  });

  it('leaves the phase alone when a live turn is refused as busy', () => {
    const host = createMockHost();
    const handler = new SessionEventHandler(host);
    host.state.appState.streamingPhase = 'tool';
    // A turn is live, so a busy refusal belongs to someone else's turn.
    vi.mocked(host.streamingUI.hasActiveTurn).mockReturnValue(true);

    handler.handleEvent(errorEvent('turn.agent_busy'), vi.fn());

    expect(host.setAppState).not.toHaveBeenCalledWith({ streamingPhase: 'idle' });
    expect(host.resetLivePane).not.toHaveBeenCalled();
  });

  it('does not collapse on other error codes — a turn may still be starting', () => {
    const host = createMockHost();
    const handler = new SessionEventHandler(host);
    host.state.appState.streamingPhase = 'waiting';
    // beginSessionRequest() clears the turn marker, so between prompt() and
    // turn.started the marker is unset even though a real turn is on its way.
    vi.mocked(host.streamingUI.hasActiveTurn).mockReturnValue(false);

    handler.handleEvent(errorEvent('records_write_failed'), vi.fn());

    expect(host.setAppState).not.toHaveBeenCalledWith({ streamingPhase: 'idle' });
    expect(host.resetLivePane).not.toHaveBeenCalled();
  });

  it('reads a turn marker that the error event itself cannot have set', () => {
    const host = createMockHost();
    const handler = new SessionEventHandler(host);
    host.state.appState.streamingPhase = 'thinking';

    handler.handleEvent(errorEvent('turn.failed'), vi.fn());

    // The premise of the convergence branch: an error carries no turnId, so it
    // never touches the marker (handleEvent only calls setTurnId for events
    // that carry one). If that ever changes, a live turn could be collapsed.
    expect(host.streamingUI.setTurnId).not.toHaveBeenCalled();
  });

  it('does not rewrite an already-idle phase', () => {
    const host = createMockHost();
    const handler = new SessionEventHandler(host);
    host.state.appState.streamingPhase = 'idle';

    handler.handleEvent(errorEvent(), vi.fn());

    expect(host.setAppState).not.toHaveBeenCalled();
    expect(host.resetLivePane).not.toHaveBeenCalled();
  });
});

describe('SessionEventHandler — parallel tool batch', () => {
  function toolResultEvent(toolCallId: string) {
    return {
      ...baseEvent('tool.result'),
      turnId: 1,
      toolCallId,
      output: 'ok',
      isError: false,
    } as unknown as Event;
  }

  it('stays in "tool" while siblings of the same batch are still running', () => {
    const host = createMockHost();
    const handler = new SessionEventHandler(host);
    host.state.appState.streamingPhase = 'tool';
    vi.mocked(host.streamingUI.hasPendingToolCalls).mockReturnValue(true);

    handler.handleEvent(toolResultEvent('call_a'), vi.fn());

    expect(host.setAppState).not.toHaveBeenCalledWith({ streamingPhase: 'waiting' });
  });

  it('falls back to "waiting" once the last tool of the batch has a result', () => {
    const host = createMockHost();
    const handler = new SessionEventHandler(host);
    host.state.appState.streamingPhase = 'tool';
    vi.mocked(host.streamingUI.hasPendingToolCalls).mockReturnValue(false);

    handler.handleEvent(toolResultEvent('call_b'), vi.fn());

    expect(host.setAppState).toHaveBeenCalledWith({ streamingPhase: 'waiting' });
  });
});

describe('SessionEventHandler — retry label clearing', () => {
  function retryingEvent() {
    return {
      ...baseEvent('turn.step.retrying'),
      turnId: 1,
      attempt: 1,
      nextAttempt: 2,
      maxAttempts: 10,
      delayMs: 20_000,
      statusCode: 429,
    } as unknown as Event;
  }

  it('drops the retry label as soon as the retried attempt streams again', () => {
    const host = createMockHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(retryingEvent(), vi.fn());
    expect(host.state.appState.reconnectAttempt).toBe(2);
    expect(host.state.appState.reconnectStatusCode).toBe(429);

    handler.handleEvent(
      {
        ...baseEvent('assistant.delta'),
        turnId: 1,
        delta: { type: 'text', text: 'hello' },
      } as unknown as Event,
      vi.fn(),
    );

    // The step is producing output again: neither the footer status block nor
    // the status bar may keep claiming "重连中" for the rest of the step.
    expect(host.state.appState.reconnectAttempt).toBe(0);
    expect(host.state.appState.reconnectStatusCode).toBeUndefined();
    expect(host.state.appState.reconnectDelayMs).toBeUndefined();
  });

  it('does not write the retry fields when no retry is in flight', () => {
    const host = createMockHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(
      {
        ...baseEvent('assistant.delta'),
        turnId: 1,
        delta: { type: 'text', text: 'hello' },
      } as unknown as Event,
      vi.fn(),
    );

    expect(host.setAppState).not.toHaveBeenCalledWith(
      expect.objectContaining({ reconnectAttempt: 0 }),
    );
  });

  it('also drops the label when the resumed attempt streams tool arguments', () => {
    const host = createMockHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(retryingEvent(), vi.fn());
    expect(host.state.appState.reconnectAttempt).toBe(2);

    // A retried attempt can resume straight into tool-call arguments, with no
    // text or thinking delta in between.
    handler.handleEvent(
      {
        ...baseEvent('tool.call.delta'),
        turnId: 1,
        toolCallId: 'call_1',
        name: 'Bash',
        argumentsPart: '{"command"',
      } as unknown as Event,
      vi.fn(),
    );

    expect(host.state.appState.reconnectAttempt).toBe(0);
    expect(host.state.appState.reconnectStatusCode).toBeUndefined();
  });
});

describe('SessionEventHandler — main-agent RLM status filtering', () => {
  it('treats main and unlabelled events as main, subagents as foreign', () => {
    expect(isMainAgentStatusEvent({ agentId: 'main' })).toBe(true);
    expect(isMainAgentStatusEvent({})).toBe(true);
    expect(isMainAgentStatusEvent({ agentId: 'agent-1' })).toBe(false);
  });

  it('never lets a subagent status event overwrite the main RLM state', () => {
    const host = createMockHost();
    const handler = new SessionEventHandler(host);
    host.state.appState.rlmEnabled = true;
    host.state.appState.rlmMaxDepth = 3;

    // Subagent event: carries its own RLM state (an inherited cap can differ
    // from main's) and must be ignored for the main badge / depth query.
    handler.handleEvent(
      {
        ...baseEvent('agent.status.updated'),
        agentId: 'agent-1',
        rlmEnabled: false,
        rlmMaxDepth: 9,
      } as unknown as Event,
      vi.fn(),
    );
    expect(host.state.appState.rlmEnabled).toBe(true);
    expect(host.state.appState.rlmMaxDepth).toBe(3);

    // Unlabelled events cannot reach the main patch path: the subagent router
    // consumes anything whose agentId is not 'main' (undefined included) before
    // handleStatusUpdate runs, so the `agentId === undefined` acceptance in
    // isMainAgentStatusEvent is defensive only. Pin the pipeline's real
    // behaviour: no label is treated as foreign, never as main.
    const { agentId, ...unlabelled } = baseEvent('agent.status.updated');
    void agentId; // deliberately dropped: an older emitter sends no label
    handler.handleEvent(
      {
        ...unlabelled,
        rlmEnabled: false,
        rlmMaxDepth: 9,
      } as unknown as Event,
      vi.fn(),
    );
    expect(host.state.appState.rlmEnabled).toBe(true);
    expect(host.state.appState.rlmMaxDepth).toBe(3);

    // Main events apply both fields, including null = unlimited.
    handler.handleEvent(
      {
        ...baseEvent('agent.status.updated'),
        agentId: 'main',
        rlmEnabled: true,
        rlmMaxDepth: null,
      } as unknown as Event,
      vi.fn(),
    );
    expect(host.state.appState.rlmEnabled).toBe(true);
    expect(host.state.appState.rlmMaxDepth).toBeNull();
  });

  it('registers a spawned instance with the spawning call resolved at spawn time', () => {
    const host = createMockHost();
    (host.streamingUI.getActiveToolCall as ReturnType<typeof vi.fn>).mockReturnValue({
      id: 'wolfpack-1',
      name: 'WolfPack',
      args: { description: 'parallel fix' },
    });
    const handler = new SessionEventHandler(host);

    handler.handleEvent(
      {
        ...baseEvent('subagent.spawned'),
        subagentId: 'sub-1',
        subagentName: 'coder',
        parentToolCallId: 'wolfpack-1',
        parentAgentId: 'main',
        description: 'fix the parser',
        runInBackground: false,
      } as unknown as Event,
      vi.fn(),
    );

    const info = handler.getSubagentInstances().get('sub-1');
    expect(info).toMatchObject({
      agentId: 'sub-1',
      type: 'coder',
      description: 'fix the parser',
      parentAgentId: 'main',
      parentToolCallId: 'wolfpack-1',
      parentToolName: 'WolfPack',
      parentToolDescription: 'parallel fix',
    });
    expect(info?.endedAt).toBeUndefined();
    // WolfPack children render under a synthesized routing id; the registry
    // keeps the REAL spawning call so the /tasks browser can name the source.
    expect(handler.subagentInfo.get('sub-1')?.parentToolCallId).toBe('sub-1');
  });

  it('archives the terminal outcome and releases the record on completed / failed', () => {
    const host = createMockHost();
    const handler = new SessionEventHandler(host);
    const spawn = (id: string): void => {
      handler.handleEvent(
        {
          ...baseEvent('subagent.spawned'),
          subagentId: id,
          subagentName: 'coder',
          parentToolCallId: `tc-${id}`,
          parentAgentId: 'main',
          runInBackground: false,
        } as unknown as Event,
        vi.fn(),
      );
    };

    spawn('sub-ok');
    handler.handleEvent(
      {
        ...baseEvent('subagent.completed'),
        subagentId: 'sub-ok',
        parentToolCallId: 'tc-sub-ok',
        resultSummary: 'done',
      } as unknown as Event,
      vi.fn(),
    );
    // The record leaves the live registry on close; its outcome is archived in
    // the row the Agents view keeps rendering.
    expect(handler.getSubagentInstances().has('sub-ok')).toBe(false);
    expect(handler.getRecentSubagentInstances().at(-1)).toMatchObject({
      type: 'coder',
      status: 'completed',
      live: false,
    });

    spawn('sub-bad');
    handler.handleEvent(
      {
        ...baseEvent('subagent.failed'),
        subagentId: 'sub-bad',
        parentToolCallId: 'tc-sub-bad',
        error: 'boom',
      } as unknown as Event,
      vi.fn(),
    );
    expect(handler.getSubagentInstances().has('sub-bad')).toBe(false);
    expect(handler.getRecentSubagentInstances().at(-1)).toMatchObject({
      type: 'coder',
      status: 'failed',
      live: false,
    });
  });

  it('archives the finished run and registers the resumed one as a fresh live record', () => {
    const host = createMockHost();
    const handler = new SessionEventHandler(host);
    // Fake just `Date` (restored below) so the two runs land on distinguishable
    // timestamps: with the real clock both happen in the same millisecond and a
    // re-stamped start time would be invisible.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const spawn = (): void => {
        handler.handleEvent(
          {
            ...baseEvent('subagent.spawned'),
            subagentId: 'sub-1',
            subagentName: 'coder',
            parentToolCallId: 'tc-1',
            parentAgentId: 'main',
            runInBackground: false,
          } as unknown as Event,
          vi.fn(),
        );
      };

      vi.setSystemTime(1_000);
      spawn();
      expect(handler.getSubagentInstances().get('sub-1')?.spawnedAt).toBe(1_000);

      vi.setSystemTime(2_000);
      handler.handleEvent(
        {
          ...baseEvent('subagent.completed'),
          subagentId: 'sub-1',
          parentToolCallId: 'tc-1',
          resultSummary: 'first pass',
        } as unknown as Event,
        vi.fn(),
      );
      // The finished run leaves the live registry and lives on as the archived
      // row the Agents view still renders.
      expect(handler.getSubagentInstances().has('sub-1')).toBe(false);
      expect(handler.getRecentSubagentInstances().at(-1)).toMatchObject({
        type: 'coder',
        status: 'completed',
      });

      // Second spawn of the same agentId = the main agent resumed it. The
      // resumed run is a new live cycle, so its start time is stamped anew —
      // the clock has moved on, and a stale start time would be visible here.
      vi.setSystemTime(61_000);
      spawn();
      const resumed = handler.getSubagentInstances().get('sub-1');
      expect(resumed?.spawnedAt).toBe(61_000);
      expect(resumed?.endedAt).toBeUndefined();
      expect(resumed?.outcome).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('attributes a routed (nested) spawn to the emitting agent', () => {
    const host = createMockHost();
    const handler = new SessionEventHandler(host);

    // A subagent spawned a grandchild: the event is routed (agentId = parent),
    // and an older emitter may omit the explicit parentAgentId.
    handler.handleEvent(
      {
        type: 'subagent.spawned',
        sessionId: 'ses-test',
        agentId: 'agent-7',
        subagentId: 'agent-8',
        subagentName: 'coder',
        parentToolCallId: 'nested-1',
      } as unknown as Event,
      vi.fn(),
    );

    expect(handler.getSubagentInstances().get('agent-8')?.parentAgentId).toBe('agent-7');
  });

  it('drops the instance registry when the runtime state resets', () => {
    const host = createMockHost();
    const handler = new SessionEventHandler(host);
    handler.handleEvent(
      {
        ...baseEvent('subagent.spawned'),
        subagentId: 'sub-1',
        subagentName: 'coder',
        parentToolCallId: 'tc-1',
        runInBackground: false,
      } as unknown as Event,
      vi.fn(),
    );
    expect(handler.getSubagentInstances().size).toBe(1);

    handler.resetRuntimeState();
    expect(handler.getSubagentInstances().size).toBe(0);
  });

  it('bounds the archive ring FIFO and empties both registries across 1000 terminations', () => {
    const host = createMockHost();
    const handler = new SessionEventHandler(host);
    const emit = (id: string, type: string, at?: string): void => {
      handler.handleEvent(
        {
          ...baseEvent(type),
          subagentId: id,
          subagentName: 'coder',
          parentToolCallId: `tc-${id}`,
          parentAgentId: 'main',
          description: at === undefined ? undefined : `task ${at}`,
          runInBackground: false,
          resultSummary: 'done',
        } as unknown as Event,
        vi.fn(),
      );
    };

    for (let i = 0; i < 1000; i += 1) {
      emit(`agent-${i}`, 'subagent.spawned', String(i));
      emit(`agent-${i}`, 'subagent.completed');
    }

    // Nothing survives its run in the live registry…
    expect(handler.getSubagentInstances().size).toBe(0);
    // …the archive keeps exactly the newest closures (FIFO: the oldest drops
    // off), so neither the retained rows nor the per-refresh rebuild grows…
    const ring = handler.getRecentSubagentInstances();
    expect(ring).toHaveLength(MAX_RECENT_SUBAGENT_INSTANCES);
    expect(ring[0]!.description).toBe(`task ${1000 - MAX_RECENT_SUBAGENT_INSTANCES}`);
    expect(ring.at(-1)!.description).toBe('task 999');
    expect(ring.every((row) => row.status === 'completed' && !row.live)).toBe(true);
    // …and the slot machine is back to resting.
    expect(handler.getSubagentSlots().filter((s) => s.count > 0 || s.status !== 'idle')).toEqual([]);
  });

  it('archives rows field-identical to the view derivation (20 samples)', () => {
    const host = createMockHost();
    const handler = new SessionEventHandler(host);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const type = 'coder';
      for (let i = 0; i < 20; i += 1) {
        const id = `agent-${i}`;
        const description = `task ${i}`;
        const spawnedAt = 10_000 + i * 100;
        const endedAt = spawnedAt + 50;
        const spawnEvent = {
          type: 'subagent.spawned' as const,
          subagentId: id,
          subagentName: type,
          parentToolCallId: `tc-${i}`,
          parentAgentId: 'main',
          description,
          runInBackground: false,
        };

        vi.setSystemTime(spawnedAt);
        handler.handleEvent({ ...baseEvent('subagent.spawned'), ...spawnEvent } as unknown as Event, vi.fn());
        vi.setSystemTime(endedAt);
        handler.handleEvent(
          {
            ...baseEvent('subagent.completed'),
            subagentId: id,
            parentToolCallId: `tc-${i}`,
            resultSummary: 'done',
          } as unknown as Event,
          vi.fn(),
        );

        // The row the view derives for the closed instance, computed from the
        // same inputs the handler had at close time (registry snapshot still
        // holding the terminal outcome + the post-termination slot state).
        const expected = buildAgentRows(
          handler.getSubagentSlots(),
          new Map([
            [
              id,
              withSubagentInstanceEnded(
                createSubagentInstanceInfo(spawnEvent, undefined, spawnedAt),
                'completed',
                endedAt,
              ),
            ],
          ]),
        ).find((row) => row.key === type);

        expect(expected).toBeDefined();
        expect(handler.getRecentSubagentInstances().at(-1)).toEqual(expected);
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
