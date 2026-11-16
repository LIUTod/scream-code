/**
 * `loop_control.max_session_tokens` / `/budget` is session-wide: every agent a
 * Session instantiates — main and subagents — must meter into the one shared
 * SessionTokenMeter, or concurrent children would burn tokens invisibly until
 * they finish and fold into the parent.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { testJian } from '../fixtures/test-jian';
import type { SDKSessionRPC } from '../../src/rpc';
import { Session } from '../../src/session';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
  }
});

function createSessionRpc(): SDKSessionRPC {
  return {
    emitEvent: vi.fn(async () => {}),
    requestApproval: vi.fn(async () => ({ decision: 'cancelled' })),
    requestQuestion: vi.fn(async () => null),
    toolCall: vi.fn(async () => ({ output: 'unsupported', isError: true })),
  } as SDKSessionRPC;
}

async function openSession(maxSessionTokens?: number): Promise<Session> {
  const dir = await mkdtemp(join(tmpdir(), 'scream-token-meter-'));
  tempDirs.push(dir);
  const workDir = join(dir, 'work');
  return new Session({
    jian: testJian.withCwd(workDir),
    id: 'session-token-meter',
    homedir: join(dir, 'session'),
    screamHomeDir: join(dir, 'home'),
    rpc: createSessionRpc(),
    skills: { explicitDirs: [join(workDir, 'missing-skills')] },
    config: {
      providers: {},
      ...(maxSessionTokens === undefined ? {} : { loopControl: { maxSessionTokens } }),
    },
  });
}

const usage = (inputOther: number, output = 0) => ({
  inputOther,
  output,
  inputCacheRead: 0,
  inputCacheCreation: 0,
});

describe('Session token meter wiring', () => {
  it('hands the main agent and every subagent the same meter', async () => {
    const session = await openSession(5_000_000);
    try {
      const main = await session.createMain();
      const { agent: child } = await session.createAgent({ type: 'sub' }, undefined, 'main');
      const { agent: grandchild } = await session.createAgent({ type: 'sub' }, undefined, child.agentId);

      expect(main.tokenMeter).toBe(session.tokenMeter);
      expect(child.tokenMeter).toBe(session.tokenMeter);
      expect(grandchild.tokenMeter).toBe(session.tokenMeter);
    } finally {
      await session.close();
    }
  });

  it('starts from loop_control.max_session_tokens and trips on usage from any agent', async () => {
    const session = await openSession(5_000_000);
    try {
      const main = await session.createMain();
      const { agent: child } = await session.createAgent({ type: 'sub' }, undefined, 'main');

      // 3M from the main agent, then 3M from a still-running child: only the
      // shared meter sees both before the child folds into its parent.
      main.usage.record('main-model', usage(3_000_000), 'turn');
      expect(session.tokenMeter.usedTokens).toBe(3_000_000);
      expect(session.tokenMeter.exhausted()).toBeUndefined();
      child.usage.record('child-model', usage(2_000_000, 1_000_000), 'turn');
      expect(session.tokenMeter.exhausted()).toEqual({ usedTokens: 6_000_000, limitTokens: 5_000_000 });
    } finally {
      await session.close();
    }
  });

  it('counts a custom model that no price catalog knows — the reason the unit is tokens', async () => {
    // Nothing about this model is configured anywhere: no catalog, no price,
    // no alias. A dollar cap would count it as free and never trip.
    const session = await openSession(1_000);
    try {
      const main = await session.createMain();
      main.usage.record('my-local-llama-3', usage(900, 200), 'turn');
      expect(session.tokenMeter.exhausted()).toEqual({ usedTokens: 1_100, limitTokens: 1_000 });
    } finally {
      await session.close();
    }
  });

  it.each([undefined, 0])('never trips without a configured limit (%s)', async (limit) => {
    const session = await openSession(limit);
    try {
      const main = await session.createMain();
      main.usage.record('any-model', usage(900_000_000), 'turn');
      expect(session.tokenMeter.usedTokens).toBe(900_000_000);
      expect(session.tokenMeter.exhausted()).toBeUndefined();
    } finally {
      await session.close();
    }
  });
});

describe('Session token budget (the /budget surface)', () => {
  it('reports used tokens and the limit, with null for "no limit"', async () => {
    const session = await openSession();
    try {
      const main = await session.createMain();
      expect(session.getSessionTokenBudget()).toEqual({ usedTokens: 0, limitTokens: null });

      main.usage.record('m', usage(1_200, 300), 'turn');
      expect(session.getSessionTokenBudget()).toEqual({ usedTokens: 1_500, limitTokens: null });
    } finally {
      await session.close();
    }
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('refuses %s and keeps the current limit', async (bad) => {
    const session = await openSession(1_000);
    try {
      expect(() => session.setSessionTokenBudget(bad)).toThrow(/non-negative whole number/);
      expect(session.getSessionTokenBudget().limitTokens).toBe(1_000);
    } finally {
      await session.close();
    }
  });

  it('changes the limit on the live session and returns the new state', async () => {
    const session = await openSession(1_000);
    try {
      const main = await session.createMain();
      main.usage.record('m', usage(5_000), 'turn');
      expect(session.tokenMeter.exhausted()).toBeDefined();

      // Raising it clears the tripped limit for every agent at once.
      expect(session.setSessionTokenBudget(10_000)).toEqual({ usedTokens: 5_000, limitTokens: 10_000 });
      expect(session.tokenMeter.exhausted()).toBeUndefined();
      expect(main.tokenMeter?.exhausted()).toBeUndefined();

      // Lowering it below what is already used trips it at once.
      expect(session.setSessionTokenBudget(2_000)).toEqual({ usedTokens: 5_000, limitTokens: 2_000 });
      expect(main.tokenMeter?.exhausted()).toEqual({ usedTokens: 5_000, limitTokens: 2_000 });

      // null removes it.
      expect(session.setSessionTokenBudget(null)).toEqual({ usedTokens: 5_000, limitTokens: null });
      expect(main.tokenMeter?.exhausted()).toBeUndefined();
    } finally {
      await session.close();
    }
  });
});
