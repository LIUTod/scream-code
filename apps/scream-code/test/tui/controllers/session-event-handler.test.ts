import { describe, expect, it, vi } from 'vitest';

import type { Event } from '@scream-code/scream-code-sdk';
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
    resetToolUi: vi.fn(),
    flushNow: vi.fn(),
    finalizeLiveTextBuffers: vi.fn(),
    finalizeAssistantStream: vi.fn(),
    finalizeTurn: vi.fn(),
    registerToolCall: vi.fn(),
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
  } as unknown as TUIState;

  const host: SessionEventHost = {
    state,
    session: undefined,
    aborted: false,
    sessionEventUnsubscribe: undefined,
    streamingUI,
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
});
