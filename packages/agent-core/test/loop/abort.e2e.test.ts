/**
 * Abort behaviour at each safe point.
 *
 * The loop's contract is that an externally-aborted turn never throws to the
 * caller and never loses already-recorded usage. The matrix here covers
 * abort triggered at every observable boundary: before the loop, during
 * the LLM call, during tool execution, between steps, and during a hook.
 */

import { inputTotal } from '@scream-code/ltod';
import { describe, expect, it } from 'vitest';

import type { LLMChatResponse, LoopHooks } from '../../src/loop/index';
import { userCancellationReason } from '../../src/utils/abort';
import { makeEndTurnResponse, makeToolCall, makeToolUseResponse } from './fixtures/fake-llm';
import { runTurn } from './fixtures/helpers';
import { EchoTool, GatedTool, HangingTool, markReadFileAccesses, SlowTool } from './fixtures/tools';

function waitOneMacrotask(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe('runTurn — abort handling', () => {
  it('returns aborted without throwing when signal is already aborted on entry', async () => {
    const controller = new AbortController();
    controller.abort();

    const { result, llm, sink, context } = await runTurn({
      responses: [makeEndTurnResponse('never executed')],
      signal: controller.signal,
    });

    expect(result.stopReason).toBe('aborted');
    expect(result.steps).toBe(0);
    // LLM was never called and no transcript envelope opened
    expect(llm.callCount).toBe(0);
    expect(context.stepBegins().length).toBe(0);
    // turn.interrupted{aborted} is emitted
    const interrupted = sink.byType('turn.interrupted');
    expect(interrupted.length).toBe(1);
    expect(interrupted[0]?.reason).toBe('aborted');
    expect(interrupted[0]?.attemptedSteps).toBe(0);
    expect(interrupted[0]?.activeStep).toBeUndefined();
    // No step.begin / step.end ever fired
    expect(sink.count('step.begin')).toBe(0);
    expect(sink.count('step.end')).toBe(0);
  });

  it('returns aborted when the LLM call itself observes the signal', async () => {
    const controller = new AbortController();
    const { result, sink, llm } = await runTurn({
      responses: [makeEndTurnResponse('not returned')],
      signal: controller.signal,
      llmAbortOnIndex: { index: 0, controller },
    });

    expect(result.stopReason).toBe('aborted');
    expect(llm.callCount).toBe(1);
    expect(sink.byType('turn.interrupted')[0]?.reason).toBe('aborted');
  });

  it('preserves usage already recorded by an earlier step when later steps abort', async () => {
    const slow = new SlowTool();
    const controller = new AbortController();

    // Scenario: step 1 records usage for an end-of-step we never reach (the
    // LLM returns first), step 2 hangs in the slow tool until we abort.
    const responses: LLMChatResponse[] = [
      makeToolUseResponse([makeToolCall('echo', { text: 'first' }, 'tc-1')], {
        inputOther: 100,
        output: 50,
      }),
      makeToolUseResponse([makeToolCall('slow', {}, 'tc-2')], {
        inputOther: 7,
        output: 11,
      }),
      // Never reached
      makeEndTurnResponse('unreachable'),
    ];

    const echo = new EchoTool();
    const turnPromise = runTurn({
      tools: [echo, slow],
      responses,
      signal: controller.signal,
    });

    // Wait for the slow tool to start, then abort.
    await slow.started.promise;
    controller.abort();

    const { result, sink } = await turnPromise;
    expect(result.stopReason).toBe('aborted');
    // Step 1 fully recorded its usage; step 2 also recorded its LLM
    // usage immediately after the chat call, before the tool aborted.
    expect(inputTotal(result.usage)).toBe(100 + 7);
    expect(result.usage.output).toBe(50 + 11);
    expect(sink.byType('turn.interrupted').map((e) => e.reason)).toContain('aborted');
  });

  it('aborts cleanly when triggered inside a beforeStep hook', async () => {
    const controller = new AbortController();
    const hooks: LoopHooks = {
      beforeStep: async () => {
        controller.abort();
        const err = new Error('aborted from hook');
        err.name = 'AbortError';
        throw err;
      },
    };

    const { result, sink, llm, context } = await runTurn({
      hooks,
      responses: [makeEndTurnResponse('never')],
      signal: controller.signal,
    });

    expect(result.stopReason).toBe('aborted');
    expect(llm.callCount).toBe(0);
    expect(context.stepBegins().length).toBe(0);
    expect(sink.byType('turn.interrupted')[0]?.reason).toBe('aborted');
  });

  it('aborts cleanly when triggered inside a prepareToolExecution hook', async () => {
    const controller = new AbortController();
    const echo = new EchoTool();
    const hooks: LoopHooks = {
      prepareToolExecution: async () => {
        controller.abort();
        const err = new Error('aborted from prepareToolExecution');
        err.name = 'AbortError';
        throw err;
      },
    };

    const { result, sink } = await runTurn({
      hooks,
      tools: [echo],
      responses: [
        makeToolUseResponse([makeToolCall('echo', { text: 'hi' }, 'tc-1')]),
        makeEndTurnResponse('never'),
      ],
      signal: controller.signal,
    });

    expect(result.stopReason).toBe('aborted');
    // tool.execute must not have been invoked
    expect(echo.calls.length).toBe(0);
    expect(sink.byType('turn.interrupted')[0]?.reason).toBe('aborted');
    // The abort that cut the hook short is classified as an abort — not as a
    // hook failure — and carries the abort's own reason.
    const toolResult = sink.byType('tool.result').find((e) => e.toolCallId === 'tc-1');
    expect(toolResult?.result).toMatchObject({
      isError: true,
      code: 'aborted',
      abortReason: expect.any(String),
    });
  });

  it('classifies a tool an abort prevented from starting as aborted', async () => {
    // The abort lands after the call was recorded but before execution starts:
    // `echo` here is a queued sibling the abort never lets run.
    const gated = new GatedTool('gated');
    const echo = new EchoTool();
    const controller = new AbortController();

    const turnPromise = runTurn({
      tools: [gated, echo],
      responses: [
        makeToolUseResponse([
          makeToolCall('gated', {}, 'tc-gated'),
          makeToolCall('echo', { text: 'never' }, 'tc-echo'),
        ]),
        makeEndTurnResponse('unreachable'),
      ],
      signal: controller.signal,
    });

    await gated.started;
    await waitOneMacrotask();
    controller.abort(userCancellationReason());
    gated.release();
    const { sink } = await turnPromise;

    expect(echo.calls.length).toBe(0);
    const echoResult = sink.byType('tool.result').find((e) => e.toolCallId === 'tc-echo');
    // The `Tool "echo" was aborted` wording only comes from the pre-execution
    // abort check, so this asserts that branch's classification.
    expect(echoResult?.result).toMatchObject({
      isError: true,
      code: 'aborted',
      abortReason: 'Aborted by the user',
    });
  });

  it('does NOT crash when an aborted turn still has work to drain', async () => {
    // A SlowTool waits forever; we abort while it's running. The loop must
    // settle gracefully and emit a single turn.interrupted.
    const slow = new SlowTool();
    const controller = new AbortController();

    const turnPromise = runTurn({
      tools: [slow],
      responses: [
        makeToolUseResponse([makeToolCall('slow', {}, 'tc-1')]),
        makeEndTurnResponse('unreachable'),
      ],
      signal: controller.signal,
    });

    await slow.started.promise;
    controller.abort();
    const { result, sink } = await turnPromise;

    expect(result.stopReason).toBe('aborted');
    // Exactly one turn.interrupted record
    expect(sink.byType('turn.interrupted').length).toBe(1);
  });

  it('classifies a tool that ignores the abort through the grace timeout', async () => {
    // The grace branch synthesizes the only result the loop produces for a tool
    // that never settles. It must carry the same `aborted` classification as
    // the regular cancellation paths, otherwise this one path would keep
    // forcing consumers to read the wording.
    const hang = new HangingTool();
    const controller = new AbortController();

    const turnPromise = runTurn({
      tools: [hang],
      responses: [
        makeToolUseResponse([makeToolCall('hang', {}, 'tc-hang')]),
        makeEndTurnResponse('unreachable'),
      ],
      signal: controller.signal,
    });

    while (hang.calls.length === 0) {
      await waitOneMacrotask();
    }
    controller.abort(userCancellationReason());
    const { result, sink } = await turnPromise;

    expect(result.stopReason).toBe('aborted');
    const toolResult = sink.byType('tool.result').find((e) => e.toolCallId === 'tc-hang');
    // The grace wording proves this result came from the timeout branch rather
    // than the pre-execution abort check.
    expect(toolResult?.result).toMatchObject({
      output: expect.stringContaining('aborted by grace timeout'),
      isError: true,
      code: 'aborted',
      abortReason: 'Aborted by the user',
    });
  });

  it('does not start a queued conflicting tool after abort', async () => {
    const gated = new GatedTool('gated');
    const echo = new EchoTool();
    const controller = new AbortController();

    const turnPromise = runTurn({
      tools: [gated, echo],
      responses: [
        makeToolUseResponse([
          makeToolCall('gated', {}, 'tc-gated'),
          makeToolCall('echo', { text: 'late mutation' }, 'tc-echo'),
        ]),
        makeEndTurnResponse('unreachable'),
      ],
      signal: controller.signal,
    });

    await gated.started;
    await waitOneMacrotask();
    expect(echo.calls.length).toBe(0);

    controller.abort();
    gated.release();
    const { result, sink } = await turnPromise;

    expect(result.stopReason).toBe('aborted');
    expect(echo.calls.length).toBe(0);
    expect(sink.byType('tool.call').map((e) => e.toolCallId)).toEqual(['tc-gated', 'tc-echo']);
    const results = sink.byType('tool.result');
    expect(results.map((e) => e.toolCallId)).toEqual(['tc-gated', 'tc-echo']);
    const echoResult = results.find((event) => event.toolCallId === 'tc-echo');
    // The cancellation classification travels with the result, so consumers
    // read `code` instead of matching the output text.
    expect(echoResult?.result).toMatchObject({
      output: 'Tool "echo" was aborted',
      isError: true,
      code: 'aborted',
      // A bare `abort()` still carries the runtime's default reason.
      abortReason: expect.any(String),
    });
  });

  it('tells the model a running tool was interrupted by the user, not by a system fault', async () => {
    // When the user presses stop, the tool_result fed back to the model must
    // convey "the user deliberately interrupted this" — not the neutral
    // `Tool "X" was aborted`, which the model mistakes for a system problem
    // (e.g. "too many parallel agents") and then theorises about / retries.
    const slow = new SlowTool();
    const controller = new AbortController();

    const turnPromise = runTurn({
      tools: [slow],
      responses: [
        makeToolUseResponse([makeToolCall('slow', {}, 'tc-1')]),
        makeEndTurnResponse('unreachable'),
      ],
      signal: controller.signal,
    });

    await slow.started.promise;
    controller.abort(userCancellationReason());
    const { result, sink } = await turnPromise;

    expect(result.stopReason).toBe('aborted');
    const toolResult = sink.byType('tool.result').find((e) => e.toolCallId === 'tc-1');
    const output = toolResult?.result.output;
    expect(typeof output).toBe('string');
    expect(output).not.toBe('Tool "slow" was aborted');
    expect(output).toContain('not a system error');
    expect(output).toContain("wait for the user");
    // The code names the cancellation lane; the abort's own reason rides along
    // so a consumer never has to re-derive it from the wording.
    expect(toolResult?.result).toMatchObject({
      code: 'aborted',
      abortReason: 'Aborted by the user',
    });
  });

  it('every tool.call still has a matching tool.result when aborted mid-batch', async () => {
    // Transcript-balance contract: even when the turn is aborted while
    // multiple tool tasks are running, every dispatched tool.call must be
    // followed by a tool.result for the same toolCallId. Without this,
    // the next turn's messages would carry orphan tool.calls and the
    // provider API would reject the conversation.
    const slow = markReadFileAccesses(new SlowTool());
    const controller = new AbortController();

    const turnPromise = runTurn({
      tools: [slow],
      responses: [
        makeToolUseResponse([
          makeToolCall('slow', {}, 'tc-1'),
          makeToolCall('slow', {}, 'tc-2'),
          makeToolCall('slow', {}, 'tc-3'),
        ]),
        makeEndTurnResponse('unreachable'),
      ],
      signal: controller.signal,
    });

    await slow.started.promise;
    controller.abort();
    const { result, sink } = await turnPromise;

    expect(result.stopReason).toBe('aborted');

    const callIds = sink
      .byType('tool.call')
      .map((e) => e.toolCallId)
      .toSorted();
    const resultIds = sink
      .byType('tool.result')
      .map((e) => e.toolCallId)
      .toSorted();
    expect(callIds).toEqual(['tc-1', 'tc-2', 'tc-3']);
    expect(resultIds).toEqual(callIds);
  });
});
