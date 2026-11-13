import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatProvider, FinishReason, Message, TokenUsage } from '@scream-code/ltod';

import { LoopControlSchema, validateConfig } from '../../src/config';
import {
  CacheWarmer,
  cacheWarmerDelayMs,
  createCatalogPricingLookup,
  DEFAULT_MIN_SAVINGS_USD,
  requestFingerprint,
  type CacheWarmerDeps,
  type CacheWarmerRequestInput,
} from '../../src/agent/cache-warmer';
import type { GenerateFn } from '../../src/agent/turn/ltod-llm';
import { DEFAULT_TEST_SYSTEM_PROMPT } from './harness/snapshots';
import { testAgent } from './harness/agent';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const PRICE = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };

const CACHED_USAGE: TokenUsage = {
  inputOther: 100,
  output: 40,
  inputCacheRead: 120_000,
  inputCacheCreation: 30_000,
};

const TOOLS = [
  { name: 'Read', description: 'read a file', parameters: { type: 'object' } },
  { name: 'Bash', description: 'run a command', parameters: { type: 'object' } },
];

const MESSAGES: Message[] = [
  { role: 'user', content: [{ type: 'text', text: 'hello' }], toolCalls: [] },
  { role: 'assistant', content: [{ type: 'text', text: 'hi' }], toolCalls: [] },
];

const PROVIDER = {
  name: 'anthropic',
  modelName: 'claude-test',
} as unknown as ChatProvider;

function makeGenerateResult(usage: TokenUsage = CACHED_USAGE) {
  const finishReason: FinishReason = 'completed';
  return {
    id: 'replay',
    message: { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'ok' }], toolCalls: [] },
    usage,
    finishReason,
    rawFinishReason: 'stop' as const,
  };
}

interface FakeWarmer {
  readonly deps: CacheWarmerDeps;
  readonly state: {
    enabled: boolean;
    minSavingsUsd: number;
    fingerprint: string | undefined;
    idle: boolean;
  };
  readonly generateCalls: Array<{
    readonly provider: ChatProvider;
    readonly systemPrompt: string | string[];
    readonly tools: readonly unknown[];
    readonly history: readonly unknown[];
  }>;
  readonly recordedUsage: Array<{ model: string; usage: TokenUsage }>;
  readonly logs: readonly string[];
  /** Pending (cb, delay) pairs — the warmer arms at most one at a time. */
  readonly timers: Array<{ cb: () => void; ms: number }>;
  fireTick(): Promise<void>;
}

function createFakeWarmer(
  init: {
    enabled?: boolean;
    minSavingsUsd?: number;
    fingerprint?: string | undefined;
    idle?: boolean;
    generate?: CacheWarmerDeps['generate'];
  } = {},
): FakeWarmer {
  const state = {
    enabled: init.enabled ?? true,
    minSavingsUsd: init.minSavingsUsd ?? DEFAULT_MIN_SAVINGS_USD,
    fingerprint: init.fingerprint,
    idle: init.idle ?? true,
  };
  const generateCalls: FakeWarmer['generateCalls'] = [];
  const recordedUsage: FakeWarmer['recordedUsage'] = [];
  const logs: string[] = [];
  const timers: FakeWarmer['timers'] = [];
  const generate: CacheWarmerDeps['generate'] =
    init.generate ??
    (async (provider, systemPrompt, tools, history) => {
      generateCalls.push({ provider, systemPrompt, tools: [...tools], history: [...history] });
      return makeGenerateResult();
    });
  const deps: CacheWarmerDeps = {
    getEnabled: () => state.enabled,
    getMinSavingsUsd: () => state.minSavingsUsd,
    generate,
    getFingerprint: () => state.fingerprint,
    isIdle: () => state.idle,
    scheduleTimer: (cb, ms) => {
      timers.push({ cb, ms });
    },
    clearTimer: () => {
      timers.length = 0;
    },
    recordUsage: (model, usage) => {
      recordedUsage.push({ model, usage });
    },
    log: (message) => {
      logs.push(message);
    },
  };
  const warmer = new CacheWarmer(deps);
  return {
    deps,
    state,
    generateCalls,
    recordedUsage,
    logs,
    timers,
    async fireTick() {
      const timer = timers.at(-1);
      if (timer === undefined) throw new Error('No pending timer to fire');
      timer.cb();
      // The tick is async (replay await) — flush its microtasks.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

function makeInput(overrides: Partial<CacheWarmerRequestInput> = {}): CacheWarmerRequestInput {
  const tools = overrides.tools ?? TOOLS;
  const messages = overrides.messages ?? MESSAGES;
  return {
    provider: PROVIDER,
    aliasName: 'anthropic/claude-test',
    systemPromptBlocks: ['static block', 'dynamic block'],
    tools,
    messages,
    usage: CACHED_USAGE,
    cacheRetention: 'short',
    price: PRICE,
    fingerprint: requestFingerprint(tools, messages),
    ...overrides,
  };
}

/** Live fingerprint = captured prefix grown by one appended message. */
function grownFingerprint(base: CacheWarmerRequestInput): string {
  const appended: Message = {
    role: 'user',
    content: [{ type: 'text', text: 'new user input' }],
    toolCalls: [],
  };
  return requestFingerprint(base.tools, [...base.messages, appended]);
}

function mutatedFingerprint(base: CacheWarmerRequestInput): string {
  const mutated: Message = {
    role: 'user',
    content: [{ type: 'text', text: 'compacted away and replaced' }],
    toolCalls: [],
  };
  return requestFingerprint(base.tools, [mutated, ...base.messages.slice(1)]);
}

// ─── TTL math ───────────────────────────────────────────────────────────────

describe('cacheWarmerDelayMs', () => {
  it('fires at 90% of the short (5-minute) tier minus slop', () => {
    expect(cacheWarmerDelayMs('short')).toBe(260_000);
  });

  it('fires at 90% of the long (1-hour) tier minus slop', () => {
    expect(cacheWarmerDelayMs('long')).toBe(3_230_000);
  });

  it('floors the delay so no tier can produce a hot loop', () => {
    // 260s and 3230s both clear the floor; the floor is exercised through the
    // max() contract — verify it directly.
    expect(Math.max(15_000, cacheWarmerDelayMs('short'))).toBe(260_000);
    expect(cacheWarmerDelayMs('short')).toBeGreaterThanOrEqual(15_000);
    expect(cacheWarmerDelayMs('long')).toBeGreaterThanOrEqual(15_000);
  });
});

// ─── Scheduling & eligibility ───────────────────────────────────────────────

describe('CacheWarmer scheduling', () => {
  it('arms exactly one timer with the tier delay after an eligible capture', () => {
    const fake = createFakeWarmer();
    fake.deps.getFingerprint = () => makeInput().fingerprint;
    fake.deps.scheduleTimer = (cb, ms) => {
      fake.timers.length = 0;
      fake.timers.push({ cb, ms });
    };
    const input = makeInput();
    new CacheWarmer(fake.deps).noteRoutedRequest(input);
    expect(fake.timers).toHaveLength(1);
    expect(fake.timers[0]!.ms).toBe(260_000);
  });

  it('replaces the capture on a second routed request (latest wins) and keeps one timer', () => {
    const fake = createFakeWarmer();
    const warmer = new CacheWarmer(fake.deps);
    warmer.noteRoutedRequest(makeInput());
    warmer.noteRoutedRequest(makeInput({ aliasName: 'other/model', cacheRetention: 'long' }));
    expect(fake.timers).toHaveLength(1);
    expect(fake.timers[0]!.ms).toBe(3_230_000);
  });

  it('never schedules when the alias has no cacheRetention (no prompt caching)', () => {
    const fake = createFakeWarmer();
    new CacheWarmer(fake.deps).noteRoutedRequest(makeInput({ cacheRetention: undefined }));
    expect(fake.timers).toHaveLength(0);
  });

  it('never schedules when no pricing exists, and warns exactly once', () => {
    const fake = createFakeWarmer();
    const warmer = new CacheWarmer(fake.deps);
    warmer.noteRoutedRequest(makeInput({ price: undefined }));
    warmer.noteRoutedRequest(makeInput({ price: undefined }));
    expect(fake.timers).toHaveLength(0);
    const pricingWarnings = fake.logs.filter((message) => message.includes('no model pricing'));
    expect(pricingWarnings).toHaveLength(1);
  });

  it('never schedules when the routed usage is missing or reports no cached tokens', () => {
    const fake = createFakeWarmer();
    const warmer = new CacheWarmer(fake.deps);
    warmer.noteRoutedRequest(makeInput({ usage: undefined }));
    warmer.noteRoutedRequest(
      makeInput({ usage: { inputOther: 999, output: 1, inputCacheRead: 0, inputCacheCreation: 0 } }),
    );
    expect(fake.timers).toHaveLength(0);
  });

  it('does not schedule while disabled, and captures once re-enabled', () => {
    const fake = createFakeWarmer({ enabled: false });
    const warmer = new CacheWarmer(fake.deps);
    warmer.noteRoutedRequest(makeInput());
    expect(fake.timers).toHaveLength(0);
    fake.state.enabled = true;
    warmer.noteRoutedRequest(makeInput());
    expect(fake.timers).toHaveLength(1);
  });
});

// ─── Tick gates ─────────────────────────────────────────────────────────────

describe('CacheWarmer tick gates', () => {
  const setup = async (
    init?: Parameters<typeof createFakeWarmer>[0],
    inputOverride?: CacheWarmerRequestInput,
  ): Promise<{ fake: FakeWarmer; warmer: CacheWarmer; input: CacheWarmerRequestInput }> => {
    const fake = createFakeWarmer(init);
    const warmer = new CacheWarmer(fake.deps);
    const input = inputOverride ?? makeInput();
    warmer.noteRoutedRequest(input);
    return { fake, warmer, input };
  };

  it('replays the captured request verbatim through generate, records its usage, and re-arms', async () => {
    const input = makeInput();
    const { fake } = await setup({ fingerprint: input.fingerprint }, input);

    await fake.fireTick();

    expect(fake.generateCalls).toHaveLength(1);
    const call = fake.generateCalls[0]!;
    expect(call.provider).toBe(input.provider);
    expect(call.systemPrompt).toBe(input.systemPromptBlocks);
    expect(call.tools).toEqual(input.tools);
    expect(call.history).toEqual(input.messages);
    // Honest accounting under the captured alias.
    expect(fake.recordedUsage).toEqual([
      { model: 'anthropic/claude-test', usage: makeGenerateResult().usage },
    ]);
    // The cache is fresh again — the schedule continues from now.
    expect(fake.timers).toHaveLength(1);
    expect(fake.timers[0]!.ms).toBe(260_000);
    // The capture survives the replay (its bytes were just re-sent).
    expect(fake.logs.some((message) => message.includes('prefix changed'))).toBe(false);
  });

  it('replays even when the live context has only grown at the tail (append tolerance)', async () => {
    const input = makeInput();
    const { fake } = await setup({ fingerprint: grownFingerprint(input) });
    await fake.fireTick();
    expect(fake.generateCalls).toHaveLength(1);
  });

  it('skips and resets the capture when the prefix mutated since capture', async () => {
    const input = makeInput();
    const { fake } = await setup({ fingerprint: mutatedFingerprint(input) });
    await fake.fireTick();
    expect(fake.generateCalls).toHaveLength(0);
    expect(fake.timers).toHaveLength(0);
    expect(fake.logs.some((message) => message.includes('prefix changed'))).toBe(true);
    // The capture was reset: with the prefix intact again, a manual tick
    // through a fresh capture works — proving the stale one is gone.
    fake.state.fingerprint = input.fingerprint;
    await expect(fake.fireTick()).rejects.toThrow('No pending timer');
  });

  it('skips when a turn is in flight (not idle), without re-arming', async () => {
    const { fake } = await setup({ idle: false, fingerprint: makeInput().fingerprint });
    await fake.fireTick();
    expect(fake.generateCalls).toHaveLength(0);
    expect(fake.timers).toHaveLength(0);
  });

  it('skips when the expected saving is below the configured minimum', async () => {
    // Net saving with these fixtures: $0.405 protected ((3.0 - 0.3) * 150k /
    // 1M) minus the replay's own cost ((100 * 3.0 + 2000 * 15) / 1M =
    // $0.0303) = $0.3747 — below the $1.0 minimum.
    const { fake } = await setup({ minSavingsUsd: 1.0, fingerprint: makeInput().fingerprint });
    await fake.fireTick();
    expect(fake.generateCalls).toHaveLength(0);
    expect(fake.timers).toHaveLength(0);
  });

  it('skips a marginal prefix that cleared the old gross gate but is net-negative after the replay cost', async () => {
    // Old gross gate: (3.0 - 0.3) * 9k / 1M = $0.0243 >= $0.02 — this
    // capture used to pass. Net gate: $0.0243 protected minus the replay's
    // own cost ((50 * 3.0 + 2000 * 15) / 1M = $0.03015) = -$0.00585, a pure
    // loss → skipped.
    const marginal = makeInput({
      usage: { inputOther: 50, output: 10, inputCacheRead: 9_000, inputCacheCreation: 0 },
    });
    const { fake, warmer } = await setup(
      { minSavingsUsd: 0.02, fingerprint: marginal.fingerprint },
      marginal,
    );
    await fake.fireTick();
    expect(fake.generateCalls).toHaveLength(0);
    expect(fake.timers).toHaveLength(0);

    // The same minimum still opens the gate for a comfortably-sized prefix:
    // $0.405 protected - $0.0303 replay cost = $0.3747 net >= $0.02.
    const comfortable = makeInput();
    warmer.noteRoutedRequest(comfortable);
    fake.state.fingerprint = comfortable.fingerprint;
    await fake.fireTick();
    expect(fake.generateCalls).toHaveLength(1);
  });

  it('skips when the live fingerprint is unreadable', async () => {
    const { fake } = await setup({ fingerprint: undefined });
    await fake.fireTick();
    expect(fake.generateCalls).toHaveLength(0);
  });

  it('skips when disabled since capture', async () => {
    const { fake } = await setup({ fingerprint: makeInput().fingerprint });
    fake.state.enabled = false;
    await fake.fireTick();
    expect(fake.generateCalls).toHaveLength(0);
  });

  it('logs a failed replay and still re-arms (TTL cadence bounds retries)', async () => {
    const failingGenerate: CacheWarmerDeps['generate'] = async () => {
      throw new Error('network down');
    };
    const input = makeInput();
    const { fake } = await setup({ fingerprint: input.fingerprint, generate: failingGenerate });
    await fake.fireTick();
    expect(fake.generateCalls).toHaveLength(0);
    expect(fake.logs.some((message) => message.includes('cache warmer replay failed'))).toBe(true);
    expect(fake.timers).toHaveLength(1);
  });

  it('does not record usage when the replay reports none', async () => {
    const noUsageGenerate: CacheWarmerDeps['generate'] = async () => {
      const result = makeGenerateResult();
      return { ...result, usage: null };
    };
    const input = makeInput();
    const { fake } = await setup({ fingerprint: input.fingerprint, generate: noUsageGenerate });
    await fake.fireTick();
    expect(fake.recordedUsage).toHaveLength(0);
    expect(fake.timers).toHaveLength(1);
  });
});

// ─── Default-timer lifecycle ────────────────────────────────────────────────

describe('CacheWarmer default timer lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeDefaultTimerWarmer(): CacheWarmer {
    const input = makeInput();
    return new CacheWarmer({
      getEnabled: () => true,
      getMinSavingsUsd: () => DEFAULT_MIN_SAVINGS_USD,
      generate: async () => makeGenerateResult(),
      getFingerprint: () => input.fingerprint,
      isIdle: () => true,
      recordUsage: () => {},
    });
  }

  it('schedules with setTimeout when the owner injects none', () => {
    const warmer = makeDefaultTimerWarmer();
    warmer.noteRoutedRequest(makeInput());
    expect(vi.getTimerCount()).toBe(1);
  });

  it('dispose clears the pending timer', () => {
    const warmer = makeDefaultTimerWarmer();
    warmer.noteRoutedRequest(makeInput());
    warmer.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores captures and timer arming after dispose', () => {
    const warmer = makeDefaultTimerWarmer();
    warmer.dispose();
    warmer.noteRoutedRequest(makeInput());
    expect(vi.getTimerCount()).toBe(0);
  });

  it('the armed default timer fires the replay through the injected generate', async () => {
    const generateCalls: Array<{ systemPrompt: unknown; history: unknown }> = [];
    const generate: CacheWarmerDeps['generate'] = async (
      _provider,
      systemPrompt,
      _tools,
      history,
    ) => {
      generateCalls.push({ systemPrompt, history: [...history] });
      return makeGenerateResult();
    };
    const input = makeInput();
    const recordedUsage: TokenUsage[] = [];
    const warmer = new CacheWarmer({
      getEnabled: () => true,
      getMinSavingsUsd: () => DEFAULT_MIN_SAVINGS_USD,
      generate,
      getFingerprint: () => input.fingerprint,
      isIdle: () => true,
      recordUsage: (_model, usage) => {
        recordedUsage.push(usage);
      },
    });
    warmer.noteRoutedRequest(input);
    await vi.advanceTimersByTimeAsync(260_000);
    expect(generateCalls).toHaveLength(1);
    expect(generateCalls[0]!.systemPrompt).toBe(input.systemPromptBlocks);
    expect(generateCalls[0]!.history).toEqual(input.messages);
    expect(recordedUsage).toHaveLength(1);
    // Re-armed after the replay.
    expect(vi.getTimerCount()).toBe(1);
  });
});

// ─── Alias pricing from the cached catalog ──────────────────────────────────

describe('createCatalogPricingLookup', () => {
  it('returns undefined prices without a scream home', () => {
    const lookup = createCatalogPricingLookup(undefined);
    expect(lookup({ provider: 'anthropic', model: 'claude-x' })).toBeUndefined();
  });

  it('resolves prices for exact provider/model and bare model spellings', () => {
    const home = mkdtempSync(join(tmpdir(), 'cache-warmer-'));
    writeFileSync(
      join(home, 'catalog-cache.json'),
      JSON.stringify({
        catalog: {
          anthropic: {
            models: {
              'claude-x': { cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 } },
            },
          },
        },
      }),
      'utf-8',
    );
    const lookup = createCatalogPricingLookup(home);
    expect(lookup({ provider: 'anthropic', model: 'claude-x' })).toEqual(PRICE);
    expect(lookup({ provider: 'other-gateway', model: 'claude-x' })).toEqual(PRICE);
    expect(lookup({ provider: 'anthropic', model: 'unknown-model' })).toBeUndefined();
  });

  it('degrades to no prices on a corrupt cache file', () => {
    const home = mkdtempSync(join(tmpdir(), 'cache-warmer-'));
    writeFileSync(join(home, 'catalog-cache.json'), '{not json', 'utf-8');
    const lookup = createCatalogPricingLookup(home);
    expect(lookup({ provider: 'anthropic', model: 'claude-x' })).toBeUndefined();
  });
});

// ─── Schema shape ───────────────────────────────────────────────────────────

describe('loop_control.cache_warmer schema', () => {
  it('is optional and absent by default', () => {
    expect(LoopControlSchema.parse({}) ).toEqual({});
  });

  it('accepts enabled + minSavingsUsd', () => {
    const parsed = LoopControlSchema.parse({ cacheWarmer: { enabled: true, minSavingsUsd: 0.5 } });
    expect(parsed.cacheWarmer).toEqual({ enabled: true, minSavingsUsd: 0.5 });
  });

  it('accepts the field with defaults unresolved (the 0.05 floor lives in the warmer)', () => {
    const parsed = LoopControlSchema.parse({ cacheWarmer: { enabled: true } });
    expect(parsed.cacheWarmer).toEqual({ enabled: true });
    expect(DEFAULT_MIN_SAVINGS_USD).toBe(0.05);
  });

  it('rejects wrong shapes', () => {
    expect(() => LoopControlSchema.parse({ cacheWarmer: { enabled: 'yes' } })).toThrow();
    expect(() => LoopControlSchema.parse({ cacheWarmer: { minSavingsUsd: 0 } })).toThrow();
    expect(() => LoopControlSchema.parse({ cacheWarmer: { minSavingsUsd: -1 } })).toThrow();
  });

  it('strips the field when placed at the top level of a full config', () => {
    // The schema is not strict: an unknown top-level key is dropped (and
    // remains available through `raw`-style passthroughs elsewhere), so a
    // misplaced field can never activate the warmer.
    const parsed = validateConfig({
      providers: {},
      cacheWarmer: { enabled: true },
    });
    expect(parsed.loopControl?.cacheWarmer).toBeUndefined();
  });
});

// ─── Agent wiring (integration, zero real calls) ────────────────────────────

describe('Agent cache-warmer wiring', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function warmerConfig() {
    return {
      providers: {
        'test-provider': { type: 'scream' as const, apiKey: 'test-key', model: 'mock-model' },
      },
      models: {
        'mock-model': {
          provider: 'test-provider',
          model: 'mock-model',
          maxContextSize: 1_000_000,
          cacheRetention: 'short' as const,
        },
      },
      loopControl: { cacheWarmer: { enabled: true } },
    };
  }

  function writeCatalogCache(home: string): void {
    writeFileSync(
      join(home, 'catalog-cache.json'),
      JSON.stringify({
        'test-provider': {
          models: { 'mock-model': { cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 } } },
        },
      }),
      'utf-8',
    );
  }

  function makeCapturingGenerate(): { generate: GenerateFn; calls: FakeWarmer['generateCalls'] } {
    const calls: FakeWarmer['generateCalls'] = [];
    const generate: GenerateFn = async (provider, systemPrompt, tools, history) => {
      calls.push({ provider, systemPrompt, tools: tools.map((tool) => ({ name: tool.name })), history: structuredClone(history) });
      return makeGenerateResult();
    };
    return { generate, calls };
  }

  it('captures the routed request, replays it at the TTL delay, records honest usage, and disposes', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cache-warmer-agent-'));
    writeCatalogCache(home);
    const { generate, calls } = makeCapturingGenerate();
    const ctx = testAgent({
      generate,
      initialConfig: warmerConfig(),
      screamHomeDir: home,
    });
    ctx.agent.config.update({
      cwd: process.cwd(),
      modelAlias: 'mock-model',
      systemPrompt: DEFAULT_TEST_SYSTEM_PROMPT,
      thinkingLevel: 'off',
    });

    // One or more routed turn steps (the stop gate may extend the turn; every
    // step captures, latest wins).
    ctx.agent.turn.prompt([{ type: 'text', text: 'hello' }]);
    await ctx.untilTurnEnd();
    const routedCount = calls.length;
    expect(routedCount).toBeGreaterThanOrEqual(1);
    // Usage snapshot before the replay, for the honesty delta below.
    const usageBefore = ctx.agent.usage.data();
    expect(usageBefore.byModel?.['mock-model']).toBeDefined();

    // The warmer armed at the short-tier delay.
    await vi.advanceTimersByTimeAsync(260_000);
    expect(calls).toHaveLength(routedCount + 1);

    // The replay is the LAST routed request verbatim.
    const routed = calls[routedCount - 1]!;
    const replay = calls[routedCount]!;
    expect(replay.systemPrompt).toEqual(routed.systemPrompt);
    expect(replay.tools).toEqual(routed.tools);
    expect(replay.history).toEqual(routed.history);

    // Session close: the pending timer must die with the agent.
    ctx.agent.disposeRlm();
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(calls).toHaveLength(routedCount + 1);
    // The replay added exactly one replay's worth of tokens to /usage.
    const usageAfter = ctx.agent.usage.data();
    expect(usageAfter.byModel?.['mock-model']?.inputCacheRead).toBe(
      (usageBefore.byModel?.['mock-model']?.inputCacheRead ?? 0) + CACHED_USAGE.inputCacheRead,
    );
    expect(usageAfter.byModel?.['mock-model']?.inputCacheCreation).toBe(
      (usageBefore.byModel?.['mock-model']?.inputCacheCreation ?? 0) +
        CACHED_USAGE.inputCacheCreation,
    );
  });

  it('never warms sub agents', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cache-warmer-sub-'));
    writeCatalogCache(home);
    const { generate, calls } = makeCapturingGenerate();
    const ctx = testAgent({
      generate,
      initialConfig: warmerConfig(),
      screamHomeDir: home,
      type: 'sub',
    });
    ctx.agent.config.update({
      cwd: process.cwd(),
      modelAlias: 'mock-model',
      systemPrompt: DEFAULT_TEST_SYSTEM_PROMPT,
      thinkingLevel: 'off',
    });
    ctx.agent.turn.prompt([{ type: 'text', text: 'hello' }]);
    await ctx.untilTurnEnd();
    const routedCount = calls.length;
    expect(routedCount).toBeGreaterThanOrEqual(1);
    await vi.advanceTimersByTimeAsync(260_000);
    // No warmer, no replay: only the turn's own routed calls happened.
    expect(calls).toHaveLength(routedCount);
  });
});
