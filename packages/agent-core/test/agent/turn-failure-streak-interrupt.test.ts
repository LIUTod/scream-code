/**
 * The consecutive-failure circuit breaker vs. interrupted tool calls.
 *
 * Interrupting a tool call is not evidence about the model, so an aborted call
 * must leave the streak untouched — otherwise a single batch of user aborts,
 * or ten cumulative ones in one turn, ends the turn reporting "N consecutive
 * tool calls have failed" and blames the model for the user's own interrupt.
 *
 * The gap this file pins: the loop only tagged aborts it synthesized itself.
 * Bash and Python handle their own interruption and return a plain
 * `builder.error(...)` result with no `code`, which the classifier read as an
 * ordinary failure — the most frequently interrupted tool path was the one the
 * breaker mis-counted. `SelfInterruptingTool` reproduces that shape.
 */

import { describe, expect, it } from 'vitest';

import type { ExecutableToolContext, ExecutableToolResult } from '../../src/loop/index';
import { testAgent, type TestAgentContext } from './harness/agent';

/** Injected at 6 consecutive failures (`toolFailureNoticeStreak`). */
const NOTICE_TEXT = '6 consecutive tool calls have failed';
/** Injected at 10 consecutive failures (`toolFailureStopStreak`). */
const STOP_TEXT = '10 consecutive tool calls have failed';
const WRAP_UP_TEXT = 'the final step of this turn';

function probeCall(toolName: string, id: string, probe: string) {
  return {
    type: 'function' as const,
    id,
    name: toolName,
    arguments: JSON.stringify({ probe }),
  };
}

function bashCall(id: string, command: string) {
  return {
    type: 'function' as const,
    id,
    name: 'Bash',
    arguments: JSON.stringify({ command, timeout: 60 }),
  };
}

/** `code` of every `tool.result` the turn emitted, in provider order. */
function toolResultCodes(ctx: TestAgentContext): Array<string | undefined> {
  return ctx.allEvents
    .filter((event) => event.type === '[rpc]' && event.event === 'tool.result')
    .map((event) => (event.args as { code?: string | undefined }).code);
}

function historyText(ctx: TestAgentContext): string {
  return JSON.stringify(ctx.agent.context.data().history);
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function registerTool(
  ctx: TestAgentContext,
  tool: { readonly name: string; readonly description: string },
  execute: (
    args: Record<string, unknown>,
    context: ExecutableToolContext,
  ) => ExecutableToolResult | Promise<ExecutableToolResult>,
): void {
  ctx.agent.tools.registerUserTool({
    name: tool.name,
    description: tool.description,
    parameters: { type: 'object', additionalProperties: true },
    execute: (args, context) => execute(args, context),
  });
}

/**
 * Handles its own interruption the way the shell tools do: it waits for the
 * abort and then returns an error result with no `code` of the loop's making.
 * `started(index)` resolves once the `index`-th call (0-based) is executing,
 * so a test can steer exactly while that call is in flight.
 */
class SelfInterruptingTool {
  readonly name = 'interruptible';
  readonly description = 'Reports its own interruption.';
  private calls = 0;
  private readonly startedPromises: Array<Promise<void>> = [];
  private readonly resolveStarted: Array<() => void> = [];

  /** Resolves when the `index`-th (0-based) call entered `execute`. */
  started(index: number): Promise<void> {
    while (this.startedPromises.length <= index) {
      let resolve: () => void = () => {};
      const promise = new Promise<void>((res) => {
        resolve = res;
      });
      this.startedPromises.push(promise);
      this.resolveStarted.push(resolve);
    }
    return this.startedPromises[index]!;
  }

  async execute(
    _args: Record<string, unknown>,
    context: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    const index = this.calls;
    this.calls += 1;
    this.resolveStarted[index]?.();
    await new Promise<void>((resolve) => {
      if (context.signal.aborted) {
        resolve();
        return;
      }
      context.signal.addEventListener('abort', () => {
        resolve();
      }, { once: true });
    });
    return {
      isError: true,
      output: 'Interrupted by the user; kernel state preserved.',
    };
  }
}

/** Reports one scripted outcome per call — never an interrupt. */
class ScriptedOutcomeTool {
  readonly name = 'probe-outcome';
  readonly description = 'Returns a scripted result per call.';
  private calls = 0;

  constructor(private readonly outcomeFor: (index: number) => ExecutableToolResult) {}

  execute(): ExecutableToolResult {
    const index = this.calls;
    this.calls += 1;
    return this.outcomeFor(index);
  }
}

describe('consecutive-failure streak vs. interrupted tool calls', () => {
  it('leaves the streak alone when the user steers out of ten in-flight calls', async () => {
    const tool = new SelfInterruptingTool();
    const ctx = testAgent();
    registerTool(ctx, tool, (args, context) => tool.execute(args, context));
    ctx.configure({ tools: [tool.name] });
    await ctx.rpc.setPermission({ mode: 'yolo' });

    const steers = Array.from(
      { length: 10 },
      (_, index) => `Interrupt ${String(index + 1)}: leave this alone.`,
    );
    for (let index = 0; index < steers.length; index += 1) {
      ctx.mockNextResponse(
        { type: 'text', text: `Probe ${String(index + 1)} starting.` },
        probeCall(tool.name, `call_probe_${String(index + 1)}`, `probe-${String(index + 1)}`),
      );
    }
    ctx.mockNextResponse({ type: 'text', text: 'All ten probes were interrupted by you.' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Probe the resource' }] });
    for (const [index, steer] of steers.entries()) {
      await tool.started(index);
      await ctx.rpc.steer({ input: [{ type: 'text', text: steer }] });
    }
    await ctx.untilTurnEnd();

    // Every one of the ten calls came back as an abort, not a failure.
    expect(toolResultCodes(ctx)).toEqual(Array.from({ length: 10 }, () => 'aborted'));

    const history = historyText(ctx);
    expect(history).not.toContain(NOTICE_TEXT);
    expect(history).not.toContain(STOP_TEXT);
    expect(history).not.toContain(WRAP_UP_TEXT);

    // The turn ran one step per attempt plus the closing report; the closing
    // report (not a wrap-up) is what ended it, and the last steer reached the
    // model before it.
    expect(ctx.llmCalls).toHaveLength(11);
    expect(JSON.stringify(ctx.llmCalls.at(-1)?.history)).toContain(steers.at(-1)!);
    expect(history).toContain('All ten probes were interrupted by you.');
  });

  it('still charges the streak for real failures: bare isError and code: failed', async () => {
    // The first three calls carry no code at all (the shape that must not be
    // mistaken for an abort when nothing was aborted), the rest classify
    // themselves as `failed`.
    const tool = new ScriptedOutcomeTool((index) =>
      index < 3
        ? { isError: true, output: `failure ${String(index + 1)} with no code` }
        : { isError: true, output: `failure ${String(index + 1)} self-classified`, code: 'failed' },
    );
    const ctx = testAgent();
    registerTool(ctx, tool, () => tool.execute());
    ctx.configure({ tools: [tool.name] });
    await ctx.rpc.setPermission({ mode: 'yolo' });

    const calls = Array.from({ length: 6 }, (_, index) =>
      probeCall(tool.name, `call_fail_${String(index + 1)}`, `fail-${String(index + 1)}`),
    );
    ctx.mockNextResponse({ type: 'text', text: 'Six probes failing.' }, ...calls);
    ctx.mockNextResponse({ type: 'text', text: 'Six real failures, reporting back.' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Probe the resource' }] });
    await ctx.untilTurnEnd();

    expect(toolResultCodes(ctx)).toEqual([
      undefined,
      undefined,
      undefined,
      'failed',
      'failed',
      'failed',
    ]);
    const history = historyText(ctx);
    expect(history).toContain(NOTICE_TEXT);
    expect(history).not.toContain(WRAP_UP_TEXT);
  });

  it('still charges the streak for permission/guard denials (code: blocked)', async () => {
    const ctx = testAgent();
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'ask' });

    const calls = Array.from({ length: 6 }, (_, index) =>
      bashCall(`call_blocked_${String(index + 1)}`, `ls missing-${String(index + 1)}.mjs`),
    );
    ctx.mockNextResponse({ type: 'text', text: 'Six commands, all guarded.' }, ...calls);
    ctx.mockNextResponse({ type: 'text', text: 'Six denials, reporting back.' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Run the commands' }] });
    await ctx.untilTurnEnd();

    expect(toolResultCodes(ctx)).toEqual(Array.from({ length: 6 }, () => 'blocked'));
    const history = historyText(ctx);
    expect(history).toContain(NOTICE_TEXT);
    expect(history).not.toContain(WRAP_UP_TEXT);
  });

  it('resets the streak when a call succeeds', async () => {
    // Six failures, one success, then five more: the stop threshold is only
    // reached if the success failed to reset the count (6 + 1 + 5 = 12).
    const tool = new ScriptedOutcomeTool((index) =>
      index === 6
        ? { output: 'probe recovered' }
        : { isError: true, output: `failure ${String(index + 1)}` },
    );
    const ctx = testAgent();
    registerTool(ctx, tool, () => tool.execute());
    ctx.configure({ tools: [tool.name] });
    await ctx.rpc.setPermission({ mode: 'yolo' });

    const failures = Array.from({ length: 6 }, (_, index) =>
      probeCall(tool.name, `call_fail_${String(index + 1)}`, `fail-${String(index + 1)}`),
    );
    ctx.mockNextResponse({ type: 'text', text: 'Six probes failing.' }, ...failures);
    ctx.mockNextResponse(
      { type: 'text', text: 'Retrying once.' },
      probeCall(tool.name, 'call_ok_1', 'ok-1'),
    );
    const moreFailures = Array.from({ length: 5 }, (_, index) =>
      probeCall(tool.name, `call_more_${String(index + 1)}`, `more-${String(index + 1)}`),
    );
    ctx.mockNextResponse({ type: 'text', text: 'Five more failures.' }, ...moreFailures);
    ctx.mockNextResponse({ type: 'text', text: 'Reporting back after the reset.' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Probe the resource' }] });
    await ctx.untilTurnEnd();

    const history = historyText(ctx);
    // The notice fired at 6; the success cleared it, so the five failures
    // that followed never re-armed it and never reached the wrap-up.
    expect(occurrences(history, NOTICE_TEXT)).toBe(1);
    expect(history).not.toContain(STOP_TEXT);
    expect(history).not.toContain(WRAP_UP_TEXT);
    expect(ctx.llmCalls).toHaveLength(4);
  });
});
