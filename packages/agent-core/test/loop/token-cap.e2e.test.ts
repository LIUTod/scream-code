/**
 * Session token cap at the loop boundary (`RunTurnInput.tokenCap`): the
 * probe runs before every step, and a reached cap ends the turn without
 * another model request — the step-budget wrap-up included.
 */

import { describe, expect, it } from 'vitest';

import {
  makeEndTurnResponse,
  makeToolCall,
  makeToolUseResponse,
} from './fixtures/fake-llm';
import { runTurn } from './fixtures/helpers';
import { EchoTool } from './fixtures/tools';

const CAP = { usedTokens: 5_200_000, limitTokens: 5_000_000 } as const;

describe('runTurn — session token cap', () => {
  it('makes no model request when the cap is already reached', async () => {
    const { result, llm, sink } = await runTurn({
      tokenCap: () => CAP,
      responses: [makeEndTurnResponse('should not be requested')],
    });

    expect(llm.callCount).toBe(0);
    expect(result.steps).toBe(0);
    expect(result.stopReason).toBe('end_turn');
    expect(result.tokenCapReached).toEqual(CAP);
    // A cap stop is not an interruption.
    expect(sink.byType('turn.interrupted')).toEqual([]);
  });

  it('stops between steps once spend crosses the cap mid-turn', async () => {
    const echo = new EchoTool();
    let calls = 0;
    const { result, llm } = await runTurn({
      tools: [echo],
      // Under the cap for the first step, over it from the second probe on.
      tokenCap: () => (calls++ === 0 ? undefined : CAP),
      responses: [
        makeToolUseResponse([makeToolCall('echo', { text: '1' }, 'a')]),
        makeEndTurnResponse('never requested'),
      ],
    });

    expect(llm.callCount).toBe(1);
    // The first step's tools still ran; no second request was made.
    expect(echo.calls.map((call) => call.id)).toEqual(['a']);
    expect(result.steps).toBe(1);
    expect(result.tokenCapReached).toEqual(CAP);
  });

  it('skips the step-budget wrap-up request when the cap is reached', async () => {
    const echo = new EchoTool();
    let calls = 0;
    const { result, llm } = await runTurn({
      maxSteps: 1,
      tools: [echo],
      tokenCap: () => (calls++ === 0 ? undefined : CAP),
      responses: [
        makeToolUseResponse([makeToolCall('echo', { text: '1' }, 'a')]),
        makeEndTurnResponse('wrap-up never requested'),
      ],
    });

    expect(llm.callCount).toBe(1);
    expect(result.tokenCapReached).toEqual(CAP);
    expect(result.stepBudgetExhausted).toBeUndefined();
  });

  it('runs normally while the probe reports no cap', async () => {
    const { result, llm } = await runTurn({
      tokenCap: () => undefined,
      responses: [makeEndTurnResponse('done')],
    });

    expect(llm.callCount).toBe(1);
    expect(result.tokenCapReached).toBeUndefined();
  });
});
