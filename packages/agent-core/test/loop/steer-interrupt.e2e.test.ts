/**
 * Covers: mid-batch steer interruption.
 *
 * When the host signals a queued user message (hasPendingSteer flips true)
 * while a tool batch is in flight, the batch's tools are interrupted with a
 * user-cancellation abort so the steered message reaches the model at the
 * next step instead of waiting out the tool.
 */

import { describe, expect, it } from 'vitest';

import { makeEndTurnResponse, makeToolCall, makeToolUseResponse } from './fixtures/fake-llm';
import { runTurn, startTurn } from './fixtures/helpers';
import { EchoTool, SlowTool } from './fixtures/tools';

describe('runTurn — steer interruption', () => {
  it('interrupts an in-flight tool when a steer is queued mid-batch', async () => {
    const slow = new SlowTool();
    let steered = false;
    const started = Date.now();

    const { promise, context } = startTurn({
      tools: [slow],
      responses: [
        makeToolUseResponse([makeToolCall('slow', {}, 'tc-1')]),
        makeEndTurnResponse('done after steer'),
      ],
      hasPendingSteer: () => steered,
    });

    // Flip the steer flag while the slow tool is definitely in flight.
    await slow.started.promise;
    steered = true;

    const turn = await promise;
    expect(turn.stopReason).toBe('end_turn');
    // The batch must have been cut short, not waited out by the tool.
    expect(Date.now() - started).toBeLessThan(2_000);

    const toolResult = context.toolResults()[0]?.result;
    expect(toolResult?.isError).toBe(true);
    const output = typeof toolResult?.output === 'string' ? toolResult.output : '';
    expect(output).toContain('manually interrupted');
  });

  it('lets the tool finish normally when no steer is queued', async () => {
    const echo = new EchoTool();
    const { result, context } = await runTurn({
      tools: [echo],
      responses: [
        makeToolUseResponse([makeToolCall('echo', { text: 'hello' }, 'tc-1')]),
        makeEndTurnResponse('done'),
      ],
      hasPendingSteer: () => false,
    });

    expect(result.stopReason).toBe('end_turn');
    const toolResult = context.toolResults()[0]?.result;
    expect(toolResult?.isError).toBeUndefined();
    expect(toolResult?.output).toBe('hello');
  });

  it('omitting hasPendingSteer keeps the batch uninterrupted (no controller overhead)', async () => {
    const echo = new EchoTool();
    const { result, context } = await runTurn({
      tools: [echo],
      responses: [
        makeToolUseResponse([makeToolCall('echo', { text: 'plain' }, 'tc-1')]),
        makeEndTurnResponse('done'),
      ],
    });

    expect(result.stopReason).toBe('end_turn');
    expect(context.toolResults()[0]?.result?.output).toBe('plain');
  });
});
