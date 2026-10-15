/**
 * Turn-level lifecycle invariants of `runTurn`.
 *
 * These tests treat the loop as a black box: they drive `runTurn` only
 * through its public input contract and assert against the public output
 * (`TurnResult`, `LoopEvent`s, transcript writes, `Tool.execute`
 * calls). Internal modules / classes / file layout are intentionally not
 * referenced.
 */

import { inputTotal } from '@scream-code/ltod';
import { describe, expect, it } from 'vitest';

import {
  makeEndTurnResponse,
  makeMaxTokensResponse,
  makeResponse,
  makeTextParts,
  makeToolCall,
  makeToolUseResponse,
} from './fixtures/fake-llm';
import { runTurn } from './fixtures/helpers';
import { EchoTool } from './fixtures/tools';

describe('runTurn — turn lifecycle', () => {
  it('returns end_turn after a single non-tool step', async () => {
    const { result, llm, sink } = await runTurn({
      responses: [makeEndTurnResponse('hello', { inputOther: 5, output: 7 })],
    });

    expect(result.stopReason).toBe('end_turn');
    expect(result.steps).toBe(1);
    expect(inputTotal(result.usage)).toBe(5);
    expect(result.usage.output).toBe(7);
    expect(llm.callCount).toBe(1);
    // step.begin and step.end at minimum, in that order
    expect(sink.count('step.begin')).toBe(1);
    expect(sink.count('step.end')).toBe(1);
    const types = sink.typesIn();
    expect(types.indexOf('step.begin')).toBeLessThan(types.indexOf('step.end'));
  });

  it('continues across tool_use steps until end_turn', async () => {
    const echo = new EchoTool();
    const { result, llm, sink, context } = await runTurn({
      tools: [echo],
      responses: [
        makeToolUseResponse([makeToolCall('echo', { text: 'hi' }, 'tc-1')], {
          inputOther: 1,
          output: 2,
        }),
        makeToolUseResponse([makeToolCall('echo', { text: 'again' }, 'tc-2')], {
          inputOther: 3,
          output: 4,
        }),
        makeEndTurnResponse('done', { inputOther: 5, output: 6 }),
      ],
    });

    expect(result.stopReason).toBe('end_turn');
    expect(result.steps).toBe(3);
    expect(inputTotal(result.usage)).toBe(1 + 3 + 5);
    expect(result.usage.output).toBe(2 + 4 + 6);
    expect(llm.callCount).toBe(3);
    expect(echo.calls.map((c) => c.id)).toEqual(['tc-1', 'tc-2']);
    // Three step envelopes were recorded
    expect(context.stepBegins().map((s) => s.step)).toEqual([1, 2, 3]);
    expect(context.stepEnds().map((s) => s.step)).toEqual([1, 2, 3]);
    // tool_use never escapes as the final stopReason
    expect(sink.byType('step.end').length).toBe(3);
  });

  it('returns max_tokens when the LLM signals it', async () => {
    const { result, sink } = await runTurn({
      responses: [makeMaxTokensResponse('partial...', { inputOther: 10, output: 20 })],
    });

    expect(result.stopReason).toBe('max_tokens');
    expect(result.steps).toBe(1);
    expect(result.usage).toEqual({
      inputOther: 10,
      output: 20,
      inputCacheRead: 0,
      inputCacheCreation: 0,
    });
    expect(sink.count('turn.interrupted')).toBe(0);
  });

  it('preserves provider terminal diagnostics when no tool calls are present', async () => {
    const { result, sink } = await runTurn({
      responses: [
        {
          ...makeResponse(makeTextParts('blocked'), [], 'filtered'),
          rawFinishReason: 'content_filter',
        },
      ],
    });

    const stepEnd = sink.byType('step.end')[0];
    expect(result.stopReason).toBe('filtered');
    expect(stepEnd?.finishReason).toBe('filtered');
    expect(stepEnd?.providerFinishReason).toBe('filtered');
    expect(stepEnd?.rawFinishReason).toBe('content_filter');
  });

  it('treats provider tool_calls without tool call structure as unknown', async () => {
    const { result } = await runTurn({
      responses: [makeResponse(makeTextParts('done'), [], 'tool_use')],
    });

    expect(result.stopReason).toBe('unknown');
  });

  it('derives tool_use from tool call structure when provider reports completed', async () => {
    const echo = new EchoTool();
    const { result, llm } = await runTurn({
      tools: [echo],
      responses: [
        makeResponse([], [makeToolCall('echo', { text: 'hi' }, 'tc-completed')], 'end_turn'),
        makeEndTurnResponse('done'),
      ],
    });

    expect(result.stopReason).toBe('end_turn');
    expect(llm.callCount).toBe(2);
    expect(echo.calls.map((c) => c.id)).toEqual(['tc-completed']);
  });

  it('does not execute tool calls when provider reports a terminal diagnostic', async () => {
    const echo = new EchoTool();
    const { result, sink } = await runTurn({
      tools: [echo],
      responses: [
        makeResponse(
          makeTextParts('blocked'),
          [makeToolCall('echo', { text: 'should-not-run' }, 'tc-filtered')],
          'filtered',
        ),
      ],
    });

    expect(result.stopReason).toBe('filtered');
    expect(echo.calls).toEqual([]);
    expect(sink.count('tool.call')).toBe(0);
    expect(sink.count('tool.result')).toBe(0);
  });

  it('wraps up with one final step when steps reach maxSteps (soft landing)', async () => {
    const echo = new EchoTool();
    const { result, sink, llm } = await runTurn({
      maxSteps: 2,
      tools: [echo],
      responses: [
        makeToolUseResponse([makeToolCall('echo', { text: '1' }, 'a')]),
        makeToolUseResponse([makeToolCall('echo', { text: '2' }, 'b')]),
        makeEndTurnResponse('stopping to report'),
      ],
    });

    expect(result.stopReason).toBe('end_turn');
    expect(result.stepBudgetExhausted).toBe(true);
    // Two budgeted steps plus the one wrap-up step.
    expect(result.steps).toBe(3);
    expect(llm.callCount).toBe(3);
    expect(echo.calls.map((c) => c.id)).toEqual(['a', 'b']);
    // Soft landing is not an interruption.
    expect(sink.byType('turn.interrupted')).toEqual([]);
  });

  it('marks the wrap-up step as finalStep for step hooks', async () => {
    const echo = new EchoTool();
    const seen: Array<[number, boolean | undefined]> = [];
    const { result } = await runTurn({
      maxSteps: 2,
      tools: [echo],
      hooks: {
        beforeStep: async ({ stepNumber, finalStep }) => {
          seen.push([stepNumber, finalStep]);
        },
      },
      responses: [
        makeToolUseResponse([makeToolCall('echo', { text: '1' }, 'a')]),
        makeToolUseResponse([makeToolCall('echo', { text: '2' }, 'b')]),
        makeEndTurnResponse('done'),
      ],
    });

    expect(result.steps).toBe(3);
    expect(seen).toEqual([
      [1, false],
      [2, false],
      [3, true],
    ]);
  });

  it('ends the turn after the wrap-up step even if it requests more tools', async () => {
    const echo = new EchoTool();
    const { result, llm } = await runTurn({
      maxSteps: 1,
      tools: [echo],
      responses: [
        makeToolUseResponse([makeToolCall('echo', { text: '1' }, 'a')]),
        makeToolUseResponse([makeToolCall('echo', { text: '2' }, 'b')]),
      ],
    });

    expect(result.stopReason).toBe('end_turn');
    expect(result.steps).toBe(2);
    // The wrap-up step's tools still execute; no further step starts.
    expect(llm.callCount).toBe(2);
    expect(echo.calls.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('does not enforce a max step limit when maxSteps is 0', async () => {
    const echo = new EchoTool();
    const { result } = await runTurn({
      maxSteps: 0,
      tools: [echo],
      responses: [
        makeToolUseResponse([makeToolCall('echo', { text: '1' }, 'a')]),
        makeToolUseResponse([makeToolCall('echo', { text: '2' }, 'b')]),
        makeEndTurnResponse('done'),
      ],
    });

    expect(result.stopReason).toBe('end_turn');
    expect(result.stepBudgetExhausted).toBeUndefined();
    expect(result.steps).toBe(3);
    expect(echo.calls).toEqual([
      { id: 'a', turnId: 'turn-1', args: { text: '1' } },
      { id: 'b', turnId: 'turn-1', args: { text: '2' } },
    ]);
  });

  it('does not enforce a max step limit when maxSteps is omitted', async () => {
    const echo = new EchoTool();
    const { result } = await runTurn({
      tools: [echo],
      responses: [
        makeToolUseResponse([makeToolCall('echo', { text: '1' }, 'a')]),
        makeToolUseResponse([makeToolCall('echo', { text: '2' }, 'b')]),
        makeToolUseResponse([makeToolCall('echo', { text: '3' }, 'c')]),
        makeToolUseResponse([makeToolCall('echo', { text: '4' }, 'd')]),
        makeEndTurnResponse('done'),
      ],
    });

    expect(result.stopReason).toBe('end_turn');
    expect(result.steps).toBe(5);
    expect(echo.calls).toEqual([
      { id: 'a', turnId: 'turn-1', args: { text: '1' } },
      { id: 'b', turnId: 'turn-1', args: { text: '2' } },
      { id: expect.any(String), turnId: 'turn-1', args: { text: '3' } },
      { id: expect.any(String), turnId: 'turn-1', args: { text: '4' } },
    ]);
  });

  it('aggregates usage across steps including cache fields', async () => {
    const echo = new EchoTool();
    const { result } = await runTurn({
      tools: [echo],
      responses: [
        makeToolUseResponse([makeToolCall('echo', { text: 'a' })], {
          inputOther: 70,
          output: 50,
          inputCacheRead: 10,
          inputCacheCreation: 20,
        }),
        makeEndTurnResponse('done', {
          inputOther: 4,
          output: 3,
          inputCacheRead: 1,
          inputCacheCreation: 2,
        }),
      ],
    });

    expect(inputTotal(result.usage)).toBe(107);
    expect(result.usage.output).toBe(53);
    expect(result.usage.inputCacheRead).toBe(11);
    expect(result.usage.inputCacheCreation).toBe(22);
  });
});
