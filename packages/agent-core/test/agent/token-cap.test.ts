import type { ToolCall } from '@scream-code/ltod';
import { describe, expect, it, vi } from 'vitest';

import { UsageRecorder } from '../../src/agent/usage';
import { SessionTokenMeter } from '../../src/agent/usage/token-meter';
import { createCommandJian, testAgent } from './harness/agent';

const USAGE = { inputOther: 1_000, output: 500, inputCacheRead: 0, inputCacheCreation: 0 } as const;

describe('SessionTokenMeter', () => {
  it('counts the same total /usage shows: input (cache reads and writes included) plus output', () => {
    const meter = new SessionTokenMeter();
    meter.record({ inputOther: 100, output: 20, inputCacheRead: 3_000, inputCacheCreation: 400 });
    expect(meter.usedTokens).toBe(3_520);
  });

  it('accumulates across records', () => {
    const meter = new SessionTokenMeter({ limitTokens: 10_000 });
    meter.record(USAGE);
    meter.record(USAGE);
    expect(meter.usedTokens).toBe(3_000);
    expect(meter.exhausted()).toBeUndefined();
  });

  it('reports the cap once usage reaches it, boundary included', () => {
    const meter = new SessionTokenMeter({ limitTokens: 3_000 });
    meter.record(USAGE);
    expect(meter.exhausted()).toBeUndefined();
    meter.record(USAGE);
    expect(meter.exhausted()).toEqual({ usedTokens: 3_000, limitTokens: 3_000 });
  });

  it.each([undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, 0.5])(
    'is off for the limit %s',
    (limit) => {
      const meter = new SessionTokenMeter({ limitTokens: limit });
      meter.record({ ...USAGE, inputOther: 10_000_000 });
      expect(meter.limitTokens).toBeUndefined();
      expect(meter.exhausted()).toBeUndefined();
    },
  );

  it('floors a fractional limit', () => {
    expect(new SessionTokenMeter({ limitTokens: 1_999.9 }).limitTokens).toBe(1_999);
  });

  it('lets the limit change on a live meter: raising clears a tripped cap, lowering trips at once', () => {
    const meter = new SessionTokenMeter({ limitTokens: 1_000 });
    meter.record(USAGE);
    expect(meter.exhausted()).toBeDefined();

    meter.setLimit(10_000);
    expect(meter.exhausted()).toBeUndefined();

    meter.setLimit(1_500);
    expect(meter.exhausted()).toEqual({ usedTokens: 1_500, limitTokens: 1_500 });

    meter.setLimit(undefined);
    expect(meter.limitTokens).toBeUndefined();
    expect(meter.exhausted()).toBeUndefined();
    // Usage kept counting while off, so turning it back on sees the real total.
    meter.setLimit(100);
    expect(meter.exhausted()).toEqual({ usedTokens: 1_500, limitTokens: 100 });
  });

  it('ignores non-finite and negative usage instead of poisoning the total', () => {
    // One NaN in `used` would make `used < limit` false forever and trip the cap permanently.
    const meter = new SessionTokenMeter({ limitTokens: 10_000 });
    meter.record({ inputOther: Number.NaN, output: 5, inputCacheRead: 0, inputCacheCreation: 0 });
    meter.record({ inputOther: -50, output: 0, inputCacheRead: 0, inputCacheCreation: 0 });
    meter.record(USAGE);
    expect(meter.usedTokens).toBe(1_500);
    expect(meter.exhausted()).toBeUndefined();
  });
});

describe('UsageRecorder → SessionTokenMeter', () => {
  function recorderWith(meter: SessionTokenMeter): UsageRecorder {
    const agent = {
      tokenMeter: meter,
      records: { logRecord: vi.fn() },
      emitStatusUpdated: vi.fn(),
    };
    return new UsageRecorder(agent as never);
  }

  it('meters fresh records, but not subagent folds or resume replays', () => {
    const meter = new SessionTokenMeter({ limitTokens: 100_000 });
    const recorder = recorderWith(meter);

    recorder.record('model-a', USAGE, 'turn');
    const afterFresh = meter.usedTokens;
    recorder.record('model-a', USAGE, 'session', { source: 'fold' });
    recorder.record('model-a', USAGE, 'turn', { skipCurrentTurn: true, source: 'replay' });

    expect(afterFresh).toBe(1_500);
    expect(meter.usedTokens).toBe(afterFresh);
    // The recorder's own totals still include every record (what /usage shows).
    expect(recorder.data().total?.inputOther).toBe(3_000);
  });

  it('counts a record with no explicit source as fresh (every live caller)', () => {
    const meter = new SessionTokenMeter({ limitTokens: 100_000 });
    recorderWith(meter).record('model-a', USAGE);
    expect(meter.usedTokens).toBe(1_500);
  });
});

describe('session token cap in the turn loop', () => {
  const bashCall: ToolCall = {
    id: 'call_bash',
    type: 'function',
    name: 'Bash',
    arguments: '{"command":"printf loop-output","timeout":60}',
  };

  // Any scripted response uses hundreds of tokens, so a limit of 1 trips on the first step.
  const tripped = () => new SessionTokenMeter({ limitTokens: 1 });

  it('ends the turn before the next request once a step crosses the cap', async () => {
    const ctx = testAgent({ jian: createCommandJian('loop-output'), tokenMeter: tripped() });
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });
    ctx.newEvents();

    ctx.mockNextResponse(bashCall);
    ctx.mockNextResponse({ type: 'text', text: 'never requested' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Run a command' }] });
    const events = await ctx.untilTurnEnd();

    // Step 1 ran (and its tool executed); step 2 was never requested.
    expect(ctx.llmCalls).toHaveLength(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: expect.objectContaining({
          reason: 'completed',
          tokenCapReached: { usedTokens: expect.any(Number), limitTokens: 1 },
        }),
      }),
    );
  });

  it('stops every later turn before its first request', async () => {
    const meter = tripped();
    const ctx = testAgent({ tokenMeter: meter });
    ctx.configure({ tools: [] });
    ctx.mockNextResponse({ type: 'text', text: 'first answer' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello' }] });
    await ctx.untilTurnEnd();
    expect(ctx.llmCalls).toHaveLength(1);
    expect(meter.exhausted()).toBeDefined();

    ctx.newEvents();
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'and again' }] });
    const events = await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: expect.objectContaining({ tokenCapReached: expect.any(Object) }),
      }),
    );
  });

  it('resumes the moment the limit is raised on the live meter (what /budget does)', async () => {
    const meter = tripped();
    const ctx = testAgent({ tokenMeter: meter });
    ctx.configure({ tools: [] });
    ctx.mockNextResponse({ type: 'text', text: 'first answer' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello' }] });
    await ctx.untilTurnEnd();

    // Blocked while tripped…
    ctx.newEvents();
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'blocked' }] });
    await ctx.untilTurnEnd();
    expect(ctx.llmCalls).toHaveLength(1);

    // …and running again as soon as the limit moves, with no restart.
    meter.setLimit(10_000_000);
    ctx.mockNextResponse({ type: 'text', text: 'second answer' });
    ctx.newEvents();
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'now it works' }] });
    const events = await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(2);
    expect(JSON.stringify(events)).not.toContain('tokenCapReached');
  });

  it('pauses at once when the limit is lowered below what was already used', async () => {
    const meter = new SessionTokenMeter({ limitTokens: 10_000_000 });
    const ctx = testAgent({ tokenMeter: meter });
    ctx.configure({ tools: [] });
    ctx.mockNextResponse({ type: 'text', text: 'first answer' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello' }] });
    await ctx.untilTurnEnd();
    expect(meter.usedTokens).toBeGreaterThan(1);

    meter.setLimit(1);
    ctx.mockNextResponse({ type: 'text', text: 'never requested' });
    ctx.newEvents();
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'again' }] });
    const events = await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(1);
    expect(JSON.stringify(events)).toContain('tokenCapReached');
  });

  it('shares one allowance across agents (what makes concurrent subagents visible)', async () => {
    const shared = tripped();
    const spender = testAgent({ tokenMeter: shared, agentId: 'agent-1' });
    const other = testAgent({ tokenMeter: shared, agentId: 'agent-2' });
    spender.configure({ tools: [] });
    other.configure({ tools: [] });

    spender.mockNextResponse({ type: 'text', text: 'spent it' });
    await spender.rpc.prompt({ input: [{ type: 'text', text: 'go' }] });
    await spender.untilTurnEnd();
    // The usage really happened on the other agent — guards against a vacuous pass.
    expect(spender.llmCalls).toHaveLength(1);
    expect(shared.exhausted()).toBeDefined();

    other.mockNextResponse({ type: 'text', text: 'never requested' });
    other.newEvents();
    await other.rpc.prompt({ input: [{ type: 'text', text: 'go too' }] });
    await other.untilTurnEnd();

    expect(other.llmCalls).toHaveLength(0);
  });

  it('leaves turns alone when no limit is configured', async () => {
    const ctx = testAgent({ tokenMeter: new SessionTokenMeter({ limitTokens: 0 }) });
    ctx.configure({ tools: [] });
    ctx.mockNextResponse({ type: 'text', text: 'one' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'a' }] });
    await ctx.untilTurnEnd();
    ctx.mockNextResponse({ type: 'text', text: 'two' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'b' }] });
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(2);
  });
});

describe('session token cap and /goal', () => {
  it('pauses an active goal instead of spinning empty goal turns, and says how to continue', async () => {
    const meter = new SessionTokenMeter({ limitTokens: 1 });
    const ctx = testAgent({ tokenMeter: meter });
    ctx.configure({ tools: [] });
    await ctx.agent.goal.createGoal({ objective: 'Ship it' });
    ctx.mockNextResponse({ type: 'text', text: 'Working on it.' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Work the goal' }] });
    await ctx.untilTurnEnd();

    // Turn 1 spent past the limit; the goal driver would open a continuation
    // turn — which ends before its first request and pauses the goal.
    await vi.waitFor(() => {
      expect(ctx.agent.goal.getGoal().goal?.status).toBe('paused');
    });
    expect(ctx.llmCalls).toHaveLength(1);
    const reason = ctx.agent.goal.getGoal().goal?.terminalReason ?? '';
    // Raising the limit does not resume a paused goal — both steps are named.
    expect(reason).toContain('Session token limit reached');
    expect(reason).toContain('/budget');
    expect(reason).toContain('/goal resume');
  });

  it('continues after the limit is raised and the goal is resumed (the flow the pause reason promises)', async () => {
    const meter = new SessionTokenMeter({ limitTokens: 1 });
    const ctx = testAgent({ tokenMeter: meter });
    ctx.configure({ tools: [] });
    await ctx.agent.goal.createGoal({ objective: 'Ship it' });
    ctx.mockNextResponse({ type: 'text', text: 'Working on it.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Work the goal' }] });
    await ctx.untilTurnEnd();
    await vi.waitFor(() => {
      expect(ctx.agent.goal.getGoal().goal?.status).toBe('paused');
    });
    expect(ctx.llmCalls).toHaveLength(1);

    meter.setLimit(10_000_000); // /budget
    await ctx.agent.goal.resumeGoal(); // /goal resume
    expect(ctx.agent.goal.getGoal().goal?.status).toBe('active');
    ctx.mockNextResponse({ type: 'text', text: 'Back to work.' });
    ctx.newEvents();
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Continue the current goal.' }] });

    // A model request was made again — the cap no longer blocks the goal.
    await vi.waitFor(() => {
      expect(ctx.llmCalls.length).toBeGreaterThanOrEqual(2);
    });
  });
});
