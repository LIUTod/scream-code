/**
 * Driver for the edit benchmark: samples (mutation class × fixture) cases,
 * corrupts fixture content, hands the corrupted file to a fresh session via
 * the eval harness and verifies the workspace file byte-for-byte afterwards.
 *
 * Cases run strictly sequentially — the harness tears down its temp workspace
 * and session between runs, so parallelism would race shared state. A full
 * default run (~40 cases) is slow and token-billed; scope it with
 * `maxCases` / `categories` while iterating.
 */

import { runEvalPrompt, type EvalUsage } from '../harness';
import { expectedAfterFix, onDiskContent } from './expected';
import { EDIT_BENCH_FIXTURES, type EditBenchFixture } from './fixtures';
import { MUTATION_CLASSES, seededRng, type MutationClass } from './mutations';

export interface EditBenchOptions {
  /** Model selector, e.g. `provider/model`. Defaults to `SCREAM_EVAL_MODEL`. */
  readonly model?: string;
  /** PRNG seed; the default is fixed so default runs stay comparable. */
  readonly seed?: number;
  /** Only run mutation classes whose category is listed here. */
  readonly categories?: readonly string[];
  /** Override the scream home (defaults to the real home). */
  readonly screamHome?: string;
  /** Cap on sampled cases (default 40). */
  readonly maxCases?: number;
  /** Called after each case so long runs can show live progress. */
  readonly onProgress?: (progress: {
    readonly completed: number;
    readonly total: number;
    readonly mutation: string;
    readonly fixture: string;
    readonly passed: boolean;
  }) => void;
}

export interface EditBenchCaseResult {
  readonly mutation: string;
  readonly category: string;
  readonly fixture: string;
  readonly passed: boolean;
  readonly verifiedFile: boolean;
  readonly timedOut: boolean;
  readonly usage?: EvalUsage;
  readonly error?: string;
}

export interface EditBenchReport {
  readonly results: readonly EditBenchCaseResult[];
  readonly passed: number;
  readonly failed: number;
  /** Cases whose mutation found no concrete site despite canApply passing. */
  readonly skipped: number;
  readonly byCategory: Record<string, { readonly passed: number; readonly failed: number }>;
  readonly totalTokens: number;
}

/** One sampled (mutation class, fixture) pair with its per-case PRNG seed. */
export interface PlannedEditBenchCase {
  readonly mutationClass: MutationClass;
  readonly fixture: EditBenchFixture;
  readonly seed: number;
}

const DEFAULT_MAX_CASES = 40;
const DEFAULT_SEED = 7;
/** Per-case seed stride: keeps case rng streams independent of case order. */
const CASE_SEED_STRIDE = 7919;

/**
 * Deterministic case planner: enumerates every applicable (class × fixture)
 * pair, then samples down to the cap with a seeded partial shuffle so runs
 * with the same seed compare case-for-case.
 */
export function planEditBenchmarkCases(
  options: Pick<EditBenchOptions, 'seed' | 'categories' | 'maxCases'> = {},
): readonly PlannedEditBenchCase[] {
  const seed = options.seed ?? DEFAULT_SEED;
  const maxCases = options.maxCases ?? DEFAULT_MAX_CASES;
  const categoryFilter =
    options.categories === undefined ? undefined : new Set(options.categories);
  const pairs: { mutationClass: MutationClass; fixture: EditBenchFixture }[] = [];
  for (const mutationClass of MUTATION_CLASSES) {
    if (categoryFilter !== undefined && !categoryFilter.has(mutationClass.category)) continue;
    for (const fixture of EDIT_BENCH_FIXTURES) {
      if (mutationClass.canApply(fixture.content)) {
        pairs.push({ mutationClass, fixture });
      }
    }
  }
  const limit = Math.min(maxCases, pairs.length);
  const rng = seededRng(seed);
  for (let i = 0; i < limit; i += 1) {
    const j = i + Math.floor(rng() * (pairs.length - i));
    const a = pairs[i];
    const b = pairs[j];
    if (a === undefined || b === undefined) continue;
    pairs[i] = b;
    pairs[j] = a;
  }
  return pairs.slice(0, limit).map((pair, index) => ({
    mutationClass: pair.mutationClass,
    fixture: pair.fixture,
    seed: seed + (index + 1) * CASE_SEED_STRIDE,
  }));
}

function buildEditBenchPrompt(fixtureName: string, instruction: string): string {
  return `In ${fixtureName}: ${instruction} Use the Edit tool. Do not rewrite the file.`;
}

/**
 * Runs the benchmark sequentially and returns the aggregated report.
 * Each case counts as passed only when the workspace file matches the
 * expected content exactly (`verifiedFile`) and the turn did not time out.
 */
export async function runEditBenchmark(
  options: EditBenchOptions = {},
): Promise<EditBenchReport> {
  const plan = planEditBenchmarkCases(options);
  const results: EditBenchCaseResult[] = [];
  let skipped = 0;
  for (const planned of plan) {
    const mutation = planned.mutationClass.mutate(planned.fixture.content, seededRng(planned.seed));
    if (mutation === null) {
      // canApply passed but no concrete site was found; count and continue so
      // the run still covers the rest of the plan.
      skipped += 1;
      continue;
    }
    const fixtureContent = onDiskContent(planned.fixture.content, mutation);
    const expected = expectedAfterFix(planned.fixture.content, planned.mutationClass, mutation);
    const prompt = buildEditBenchPrompt(
      planned.fixture.name,
      planned.mutationClass.instruction(mutation, planned.fixture.name),
    );
    try {
      const result = await runEvalPrompt(
        { prompt, fixtures: [{ name: planned.fixture.name, content: fixtureContent }] },
        {
          model: options.model,
          screamHome: options.screamHome,
          verifyFileAfterTurn: { path: planned.fixture.name, content: expected },
        },
      );
      results.push({
        mutation: planned.mutationClass.name,
        category: planned.mutationClass.category,
        fixture: planned.fixture.name,
        passed: result.verifiedFile && !result.timedOut,
        verifiedFile: result.verifiedFile,
        timedOut: result.timedOut,
        usage: result.usage,
      });
    } catch (error) {
      results.push({
        mutation: planned.mutationClass.name,
        category: planned.mutationClass.category,
        fixture: planned.fixture.name,
        passed: false,
        verifiedFile: false,
        timedOut: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    options.onProgress?.({
      completed: results.length,
      total: plan.length,
      mutation: planned.mutationClass.name,
      fixture: planned.fixture.name,
      passed: results.at(-1)?.passed ?? false,
    });
  }

  const byCategory: Record<string, { passed: number; failed: number }> = {};
  let passedCount = 0;
  let failedCount = 0;
  let totalTokens = 0;
  for (const result of results) {
    const stat = byCategory[result.category] ?? { passed: 0, failed: 0 };
    if (result.passed) {
      passedCount += 1;
      stat.passed += 1;
    } else {
      failedCount += 1;
      stat.failed += 1;
    }
    byCategory[result.category] = stat;
    totalTokens += result.usage?.totalTokens ?? 0;
  }

  return {
    results,
    passed: passedCount,
    failed: failedCount,
    skipped,
    byCategory,
    totalTokens,
  };
}
