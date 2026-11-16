/**
 * The `/budget` surface end to end through the real harness: read and change
 * the limit on a live session over the SDK → core → session RPC chain, and the
 * "save as the default" half (`setConfig` → config.toml → the next session).
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ScreamHarness } from '#/index';
import { makeTempDir, removeTempDirs } from './session-runtime-helpers';
import { TEST_IDENTITY } from './test-identity';

const tempDirs: string[] = [];

afterEach(async () => {
  await removeTempDirs(tempDirs);
});

async function fixture(): Promise<{ harness: ScreamHarness; homeDir: string; workDir: string }> {
  const homeDir = await makeTempDir(tempDirs, 'scream-sdk-budget-home-');
  const workDir = await makeTempDir(tempDirs, 'scream-sdk-budget-work-');
  return { harness: new ScreamHarness({ homeDir, identity: TEST_IDENTITY }), homeDir, workDir };
}

describe('Session token budget over the SDK', () => {
  it('starts with no limit and nothing used', async () => {
    const { harness, workDir } = await fixture();
    try {
      const session = await harness.createSession({ id: 'ses_budget_fresh', workDir });
      await expect(session.getSessionTokenBudget()).resolves.toEqual({
        usedTokens: 0,
        limitTokens: null,
      });
    } finally {
      await harness.close();
    }
  });

  it('changes the limit on the live session and reads it back', async () => {
    const { harness, workDir } = await fixture();
    try {
      const session = await harness.createSession({ id: 'ses_budget_live', workDir });

      await expect(session.setSessionTokenBudget(50_000_000)).resolves.toEqual({
        usedTokens: 0,
        limitTokens: 50_000_000,
      });
      await expect(session.getSessionTokenBudget()).resolves.toMatchObject({ limitTokens: 50_000_000 });

      await expect(session.setSessionTokenBudget(null)).resolves.toMatchObject({ limitTokens: null });
      await expect(session.getSessionTokenBudget()).resolves.toMatchObject({ limitTokens: null });
    } finally {
      await harness.close();
    }
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_VALUE])(
    'refuses %s instead of quietly reading it as "no limit", and leaves the limit alone',
    async (bad) => {
      const { harness, workDir } = await fixture();
      try {
        const session = await harness.createSession({ id: 'ses_budget_bad', workDir });
        await session.setSessionTokenBudget(1_000);

        await expect(session.setSessionTokenBudget(bad)).rejects.toMatchObject({
          name: 'ScreamError',
          code: 'request.invalid',
        });
        await expect(session.getSessionTokenBudget()).resolves.toMatchObject({ limitTokens: 1_000 });
      } finally {
        await harness.close();
      }
    },
  );

  it('accepts 0 as another spelling of "no limit"', async () => {
    const { harness, workDir } = await fixture();
    try {
      const session = await harness.createSession({ id: 'ses_budget_zero', workDir });
      await session.setSessionTokenBudget(1_000);
      await expect(session.setSessionTokenBudget(0)).resolves.toMatchObject({ limitTokens: null });
    } finally {
      await harness.close();
    }
  });

  it('keeps the limit per session', async () => {
    const { harness, workDir } = await fixture();
    try {
      const a = await harness.createSession({ id: 'ses_budget_a', workDir });
      const b = await harness.createSession({ id: 'ses_budget_b', workDir });
      await a.setSessionTokenBudget(1_000);

      await expect(b.getSessionTokenBudget()).resolves.toMatchObject({ limitTokens: null });
    } finally {
      await harness.close();
    }
  });

  it('starts a new session from the saved default, and 0 means "no limit"', async () => {
    const { harness, homeDir, workDir } = await fixture();
    try {
      // What `/budget 20m` persists…
      await harness.setConfig({ loopControl: { maxSessionTokens: 20_000_000 } });
      const toml = await readFile(join(homeDir, 'config.toml'), 'utf-8');
      expect(toml).toContain('max_session_tokens = 20000000');

      const withLimit = await harness.createSession({ id: 'ses_budget_default', workDir });
      await expect(withLimit.getSessionTokenBudget()).resolves.toMatchObject({
        limitTokens: 20_000_000,
      });

      // …and what `/budget off` persists: a patch cannot delete a key, so it writes 0.
      await harness.setConfig({ loopControl: { maxSessionTokens: 0 } });
      expect(await readFile(join(homeDir, 'config.toml'), 'utf-8')).toContain('max_session_tokens = 0');

      const withoutLimit = await harness.createSession({ id: 'ses_budget_off', workDir });
      await expect(withoutLimit.getSessionTokenBudget()).resolves.toMatchObject({ limitTokens: null });
    } finally {
      await harness.close();
    }
  });

  it('rejects a negative or fractional default instead of writing it', async () => {
    const { harness, homeDir } = await fixture();
    try {
      await expect(
        harness.setConfig({ loopControl: { maxSessionTokens: -5 } }),
      ).rejects.toBeDefined();
      await expect(
        harness.setConfig({ loopControl: { maxSessionTokens: 1.5 } }),
      ).rejects.toBeDefined();
      const text = await readFile(join(homeDir, 'config.toml'), 'utf-8').catch(() => '');
      expect(text).not.toContain('max_session_tokens');
    } finally {
      await harness.close();
    }
  });
});
