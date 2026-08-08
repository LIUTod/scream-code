/**
 * End-to-end smoke eval: the cheapest possible check that the agent loop,
 * provider auth and prompt pipeline work against a real model.
 *
 * Run with: `pnpm eval` from the repo root (or `pnpm -C packages/evals run eval`).
 * Model selection: `SCREAM_EVAL_MODEL` env var, e.g. `provider/model`.
 */

import { describe, expect, it } from 'vitest';

import { runEvalPrompt } from './harness';

describe('scream smoke eval', () => {
  it('answers a trivial question and reports token usage', async () => {
    const result = await runEvalPrompt(
      'What is the capital of France? Answer in one word.',
    );
    const lower = result.output.toLowerCase();
    // Accept both the English name and the Chinese name — the model may
    // answer in either language.
    expect(lower.includes('paris') || lower.includes('巴黎')).toBe(true);
    expect(result.usage.totalTokens).toBeGreaterThan(0);
    expect(result.usage.model.length).toBeGreaterThan(0);
  });
});
