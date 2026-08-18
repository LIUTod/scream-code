import { afterEach, describe, expect, it, vi } from 'vitest';

import { StreamingUIController } from '#/tui/controllers/streaming-ui';
import type { StreamingUIHost } from '#/tui/controllers/streaming-ui';
import { getSharedSpeedTracker, resetSharedSpeedTracker } from '#/tui/utils/speed-tracker';
import type { ToolCallBlockData } from '#/tui/types';

function createMockHost(): StreamingUIHost {
  return {
    state: {
      appState: {
        streamingPhase: 'idle',
        streamingStartTime: 0,
      },
      theme: {
        markdownTheme: {} as unknown as StreamingUIHost['state']['theme']['markdownTheme'],
        colors: {},
      },
      transcriptContainer: {
        addChild: vi.fn(),
      } as unknown as StreamingUIHost['state']['transcriptContainer'],
      ui: {
        requestRender: vi.fn(),
      } as unknown as StreamingUIHost['state']['ui'],
    } as unknown as StreamingUIHost['state'],
    session: undefined,
    setAppState: vi.fn(),
    patchLivePane: vi.fn(),
    resetLivePane: vi.fn(),
    updateActivityPane: vi.fn(),
    updateQueueDisplay: vi.fn(),
    requireSession: vi.fn(),
    deferUserMessages: false,
    shiftQueuedMessage: vi.fn(),
    pushTranscriptEntry: vi.fn(),
    onTurnCompleted: vi.fn(),
    transcriptController: {
      registerLiveComponent: vi.fn(),
      markPending: vi.fn(),
      unmarkPending: vi.fn(),
      commit: vi.fn(),
    } as unknown as StreamingUIHost['transcriptController'],
  };
}

describe('StreamingUIController', () => {
  it('markStepTruncated only affects matching, in-flight streaming tool calls', () => {
    const controller = new StreamingUIController(createMockHost());

    const calls: ToolCallBlockData[] = [
      {
        id: 'tc-1',
        name: 'Bash',
        args: {},
        streamingArguments: 'ls',
        turnId: 'turn-1',
        step: 1,
      },
      {
        id: 'tc-2',
        name: 'Bash',
        args: {},
        streamingArguments: 'cat',
        turnId: 'turn-1',
        step: 1,
      },
      {
        id: 'tc-3',
        name: 'Bash',
        args: {},
        streamingArguments: 'pwd',
        turnId: 'turn-2',
        step: 1,
      },
      {
        id: 'tc-4',
        name: 'Bash',
        args: {},
        // no streamingArguments
        turnId: 'turn-1',
        step: 1,
      },
      {
        id: 'tc-5',
        name: 'Bash',
        args: {},
        streamingArguments: 'echo',
        turnId: 'turn-1',
        step: 1,
        result: { tool_call_id: 'tc-5', output: 'done' },
      },
      {
        id: 'tc-6',
        name: 'Bash',
        args: {},
        streamingArguments: 'grep',
        turnId: 'turn-1',
        step: 2,
      },
    ];

    for (const toolCall of calls) {
      controller.setActiveToolCall(toolCall.id, toolCall);
    }

    const count = controller.markStepTruncated('turn-1', 1);

    expect(count).toBe(2);
    expect(controller.getActiveToolCall('tc-1')?.truncated).toBe(true);
    expect(controller.getActiveToolCall('tc-2')?.truncated).toBe(true);
    expect(controller.getActiveToolCall('tc-5')?.truncated).toBeUndefined();
    expect(controller.getActiveToolCall('tc-3')?.truncated).toBeUndefined();
    expect(controller.getActiveToolCall('tc-4')?.truncated).toBeUndefined();
    expect(controller.getActiveToolCall('tc-6')?.truncated).toBeUndefined();
  });

  it('turn context accessors track current turn id and step', () => {
    const controller = new StreamingUIController(createMockHost());

    expect(controller.getTurnContext()).toEqual({ turnId: undefined, step: 0 });

    controller.setTurnId('turn-42');
    controller.setStep(3);

    expect(controller.getTurnContext()).toEqual({ turnId: 'turn-42', step: 3 });
    expect(controller.hasActiveTurn()).toBe(true);
  });
});

describe('smooth streaming (token pacing)', () => {
  afterEach(() => {
    resetSharedSpeedTracker();
  });

  it('advances the shown cursor by the per-frame budget and never freezes', () => {
    const controller = new StreamingUIController(createMockHost());
    const updates: string[] = [];
    (controller as unknown as { onStreamingTextUpdate: (text: string) => void }).onStreamingTextUpdate =
      (text: string) => updates.push(text);

    // No speed samples yet → budget uses the default assumed rate (50 tok/s →
    // ceil(50 * 0.05 * 2.5) = 7 chars/frame), so the first block flows instead
    // of crawling at MIN=1.
    controller.appendAssistantDelta('abcdefghij');
    for (let i = 0; i < 10; i++) {
      (controller as unknown as { flush: () => void }).flush();
    }

    expect(updates[0]).toBe('abcdefg');
    expect(updates.at(-1)).toBe('abcdefghij'); // fully shown → frame stops
    expect(controller.hasPending()).toBe(false);
  });

  it('finalize renders any remaining un-shown text in one shot', () => {
    const controller = new StreamingUIController(createMockHost());
    const updates: string[] = [];
    (controller as unknown as { onStreamingTextUpdate: (text: string) => void }).onStreamingTextUpdate =
      (text: string) => updates.push(text);

    controller.appendAssistantDelta('hello world');
    (controller as unknown as { flush: () => void }).flush(); // only budgeted chars shown
    controller.finalizeAssistantStream();

    expect(updates.at(-1)).toBe('hello world'); // rest flushed on end
  });

  it('resetLiveText clears the shown cursor and pending state', () => {
    const controller = new StreamingUIController(createMockHost());
    controller.appendAssistantDelta('xyz');
    controller.resetLiveText();
    expect(
      (controller as unknown as { _shownAssistantLength: number })._shownAssistantLength,
    ).toBe(0);
    expect(controller.hasPending()).toBe(false);
  });

  it('tracks a fast arrival rate instead of falling back to the minimum budget', () => {
    const controller = new StreamingUIController(createMockHost());
    const updates: string[] = [];
    (controller as unknown as { onStreamingTextUpdate: (text: string) => void }).onStreamingTextUpdate =
      (text: string) => updates.push(text);

    // Simulate a fast model: budget scales to the arrival rate
    // (80 tok/s → ceil(80 * 0.05 * 2.5) = 10 chars/frame), not MIN=1.
    getSharedSpeedTracker().observe(80);
    controller.appendAssistantDelta('x'.repeat(50));
    (controller as unknown as { flush: () => void }).flush();

    expect(updates[0]).toBe('x'.repeat(10));
  });
});
