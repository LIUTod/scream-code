import { describe, expect, it, vi } from 'vitest';

import type { Event, Session } from '@scream-code/scream-code-sdk';
import {
  SessionEventHandler,
  type SessionEventHost,
} from '#/tui/controllers/session-event-handler';
import type { StreamingUIController } from '#/tui/controllers/streaming-ui';
import type { TasksBrowserController } from '#/tui/controllers/tasks-browser';
import type { TUIState } from '#/tui/tui-state';
import type { TranscriptEntry } from '#/tui/types';

function createMockHost(): SessionEventHost {
  const streamingUI = {
    setStep: vi.fn(),
    setTurnId: vi.fn(),
    resetLiveText: vi.fn(),
    resetToolUi: vi.fn(),
    flushNow: vi.fn(),
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
    expect(host.setAppState).toHaveBeenCalledWith({ reconnectAttempt: 2 });
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
});
