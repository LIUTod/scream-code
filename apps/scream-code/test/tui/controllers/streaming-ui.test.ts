import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_CHARS_PER_FRAME,
  SMOOTH_CATCHUP_MAX_PER_FRAME,
  SMOOTH_CATCHUP_THRESHOLD,
} from '#/tui/constant/streaming';
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

  it('hasPendingToolCalls tracks calls of the current step that have no result', () => {
    const controller = new StreamingUIController(createMockHost());
    controller.setTurnId('turn-1');
    controller.setStep(1);

    expect(controller.hasPendingToolCalls()).toBe(false);

    controller.setActiveToolCall('tc-pending', {
      id: 'tc-pending',
      name: 'Bash',
      args: {},
      turnId: 'turn-1',
      step: 1,
    });
    controller.setActiveToolCall('tc-done', {
      id: 'tc-done',
      name: 'Bash',
      args: {},
      turnId: 'turn-1',
      step: 1,
      result: { tool_call_id: 'tc-done', output: 'ok' },
    });

    // Only the call without a result keeps the batch open.
    expect(controller.hasPendingToolCalls()).toBe(true);

    controller.completeToolResult('tc-pending', {
      tool_call_id: 'tc-pending',
      output: 'ok',
    });

    expect(controller.hasPendingToolCalls()).toBe(false);
  });

  it('hasPendingToolCalls ignores entries from an earlier step or turn', () => {
    const controller = new StreamingUIController(createMockHost());
    controller.setTurnId('turn-2');
    controller.setStep(1);

    // An abandoned call from an earlier step can never settle, so counting it
    // would pin the footer in "执行中" for the rest of the turn.
    controller.setActiveToolCall('tc-stale-step', {
      id: 'tc-stale-step',
      name: 'Bash',
      args: {},
      turnId: 'turn-2',
      step: 0,
    });
    controller.setActiveToolCall('tc-stale-turn', {
      id: 'tc-stale-turn',
      name: 'Bash',
      args: {},
      turnId: 'turn-1',
      step: 1,
    });

    expect(controller.hasPendingToolCalls()).toBe(false);
  });
});

/** Runs one smooth-streaming frame: `flush` is private, tests drive it directly. */
function flushFrame(controller: StreamingUIController): void {
  (controller as unknown as { flush: () => void }).flush();
}

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
    // 50 * 0.05 = 2.5 tokens/frame ≈ 10 Latin chars at 4 chars/token), so the
    // first block flows instead of crawling at MIN=1.
    controller.appendAssistantDelta('abcdefghijklmnopqrst');
    for (let i = 0; i < 10; i++) {
      (controller as unknown as { flush: () => void }).flush();
    }

    expect(updates[0]).toBe('abcdefghij');
    expect(updates.at(-1)).toBe('abcdefghijklmnopqrst'); // fully shown → frame stops
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

  it('resetLiveText settles the block it abandons, so drawing is not stranded', () => {
    // An aborted request or a retried step leaves this message on screen with no
    // further updates. Anything that waits for the reply to finish — drawing a
    // diagram — would never run if the block kept claiming it was mid-stream.
    const controller = new StreamingUIController(createMockHost());
    const block = {
      entry: {},
      component: {
        streaming: true,
        setStreaming(value: boolean): void {
          this.streaming = value;
        },
      },
    };
    (controller as unknown as { _streamingBlock: unknown })._streamingBlock = block;

    controller.resetLiveText();

    expect(block.component.streaming).toBe(false);
    expect((controller as unknown as { _streamingBlock: unknown })._streamingBlock).toBeNull();
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
    // (80 tok/s → 80 * 0.05 = 4 tokens/frame ≈ 16 Latin chars at 4
    // chars/token), not MIN=1.
    // Seed with the real clock so the windowed getSpeed() (called with a real
    // performance.now()) keeps this observation in-window.
    getSharedSpeedTracker().observe(80, 1000, performance.now());
    controller.appendAssistantDelta('x'.repeat(50));
    (controller as unknown as { flush: () => void }).flush();

    expect(updates[0]).toBe('x'.repeat(16));
  });

  it('catches up on fast arrival instead of lagging until finalize', () => {
    const controller = new StreamingUIController(createMockHost());
    const shownLengths: number[] = [];
    (controller as unknown as { onStreamingTextUpdate: (text: string) => void }).onStreamingTextUpdate =
      (text: string) => shownLengths.push(text.length);

    // >500 chars/s: 75 chars arrive on every 50ms frame (1500 chars/s), far
    // past what the base budget (MAX_CHARS_PER_FRAME per SMOOTH_FRAME_MS) can
    // absorb.
    const frameChars = 75;
    const arrivalFrames = 40;
    const total = frameChars * arrivalFrames;

    for (let i = 0; i < arrivalFrames; i++) {
      controller.appendAssistantDelta('x'.repeat(frameChars));
      flushFrame(controller);
    }

    // The lag converges to ≈8 frames of arrival (≈400ms) instead of growing
    // with the stream: without catch-up this backlog would be
    // total - MAX_CHARS_PER_FRAME * arrivalFrames = 2000 chars.
    const backlogAtArrivalEnd = total - shownLengths.at(-1)!;
    expect(backlogAtArrivalEnd).toBeLessThanOrEqual(8 * frameChars);
    // The remaining tail is larger than any single frame may drain, so it can
    // only finish by continuing to advance frame by frame.
    expect(backlogAtArrivalEnd).toBeGreaterThan(SMOOTH_CATCHUP_MAX_PER_FRAME);

    // Arrival stops; the continuation frames drain the tail — finalize is
    // never needed to complete the display.
    let drainFrames = 0;
    while (shownLengths.at(-1)! < total && drainFrames < 120) {
      flushFrame(controller);
      drainFrames += 1;
    }
    expect(shownLengths.at(-1)).toBe(total);

    // No frame dumps the whole remainder in one jump.
    const deltas = shownLengths.map((length, i) => length - (i === 0 ? 0 : shownLengths[i - 1]!));
    expect(Math.max(...deltas)).toBeLessThanOrEqual(SMOOTH_CATCHUP_MAX_PER_FRAME);
  });

  it('keeps the base pacing while the backlog stays below the catch-up threshold', () => {
    const controller = new StreamingUIController(createMockHost());
    const shownLengths: number[] = [];
    (controller as unknown as { onStreamingTextUpdate: (text: string) => void }).onStreamingTextUpdate =
      (text: string) => shownLengths.push(text.length);

    // Just under the trigger: below the threshold the old pacing must hold.
    const total = SMOOTH_CATCHUP_THRESHOLD - 10;
    controller.appendAssistantDelta('y'.repeat(total));
    for (let i = 0; i < 40; i++) {
      flushFrame(controller);
    }

    expect(shownLengths.at(-1)).toBe(total);
    const deltas = shownLengths.map((length, i) => length - (i === 0 ? 0 : shownLengths[i - 1]!));
    // Catch-up never applied: every frame stays within the base ceiling.
    expect(Math.max(...deltas)).toBeLessThanOrEqual(MAX_CHARS_PER_FRAME);
  });
});
