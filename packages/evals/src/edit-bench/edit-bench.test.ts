/**
 * Unit tests for the edit benchmark. The eval harness is mocked, so no test
 * here ever touches a real model or the network; the real-model runs happen
 * through `src/edit-bench/cli.ts` / `runEditBenchmark` by hand.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  runEvalPrompt,
  type EvalFixture,
  type EvalHarnessOptions,
  type EvalResult,
  type EvalRunInput,
} from '../harness';
import { applyExternalShift, expectedAfterFix, onDiskContent } from './expected';
import { EDIT_BENCH_FIXTURES } from './fixtures';
import {
  MUTATION_CLASSES,
  applyMutation,
  seededRng,
  type ExternalShift,
  type MutationClass,
  type MutationResult,
  WRONG_COMMENT_TEXTS,
} from './mutations';
import { planEditBenchmarkCases, runEditBenchmark } from './run';

vi.mock('../harness', () => ({
  runEvalPrompt: vi.fn(),
}));

const runEvalPromptMock = vi.mocked(runEvalPrompt);

const CANNED_RESULT: EvalResult = {
  output: 'done',
  timedOut: false,
  verifiedFile: true,
  usage: {
    provider: 'test',
    model: 'test-model',
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
  },
};

const SEEDS: readonly number[] = [1, 2, 3, 7, 12345];

function countWholeWord(content: string, word: string): number {
  const escaped = word.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?<![A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_$])`, 'g');
  return [...content.matchAll(pattern)].length;
}

/** Number of differing lines between two contents with equal line counts. */
function differingLines(before: string, after: string): number {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  expect(afterLines.length).toBe(beforeLines.length);
  let differing = 0;
  for (let i = 0; i < beforeLines.length; i += 1) {
    if (beforeLines[i] !== afterLines[i]) differing += 1;
  }
  return differing;
}

interface PlannedCall {
  readonly input: EvalRunInput;
  readonly options: EvalHarnessOptions;
  readonly fixtures: readonly EvalFixture[];
}

function mockedCallAt(index: number): PlannedCall {
  const call = runEvalPromptMock.mock.calls[index];
  if (call === undefined) throw new Error(`expected a mock call at ${index}`);
  const [input, options] = call;
  if (typeof input === 'string') throw new Error('expected an object EvalRunInput');
  if (options === undefined) throw new Error('expected harness options');
  const fixtures = input.fixtures;
  if (fixtures === undefined) throw new Error('expected fixtures on the input');
  return { input, options, fixtures };
}

describe('seededRng', () => {
  it('produces the same sequence for the same seed', () => {
    const first = seededRng(123);
    const second = seededRng(123);
    const firstValues = Array.from({ length: 100 }, () => first());
    const secondValues = Array.from({ length: 100 }, () => second());
    expect(secondValues).toEqual(firstValues);
  });

  it('produces different sequences for different seeds', () => {
    const first = seededRng(1);
    const second = seededRng(2);
    const firstValues = Array.from({ length: 20 }, () => first());
    const secondValues = Array.from({ length: 20 }, () => second());
    expect(secondValues).not.toEqual(firstValues);
  });

  it('returns values in [0, 1)', () => {
    const rng = seededRng(99);
    for (let i = 0; i < 200; i += 1) {
      const value = rng();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe('mutation classes', () => {
  for (const mutationClass of MUTATION_CLASSES) {
    describe(mutationClass.name, () => {
      it('canApply is pure across every fixture', () => {
        for (const fixture of EDIT_BENCH_FIXTURES) {
          expect(mutationClass.canApply(fixture.content)).toBe(
            mutationClass.canApply(fixture.content),
          );
        }
      });

      for (const fixture of EDIT_BENCH_FIXTURES) {
        const applies = mutationClass.canApply(fixture.content);

        it.skipIf(!applies)(
          `mutates deterministically and fixes back to the pristine fixture on ${fixture.name}`,
          () => {
            for (const seed of SEEDS) {
              const mutation = mutationClass.mutate(fixture.content, seededRng(seed));
              if (mutation === null) {
                throw new Error('mutate returned null although canApply passed');
              }
              expect(mutationClass.mutate(fixture.content, seededRng(seed))).toEqual(mutation);

              const mutated = applyMutation(fixture.content, mutation);
              expect(mutated).not.toEqual(fixture.content);
              if (mutation.line !== undefined) {
                expect(mutation.line).toBeGreaterThanOrEqual(1);
                expect(mutation.line).toBeLessThanOrEqual(mutated.split('\n').length);
              }
              expect(mutationClass.fix(mutated, mutation)).toEqual(fixture.content);
            }
          },
        );

        it.skipIf(!applies)(`mutation shape matches the promise on ${fixture.name}`, () => {
          const mutation = mutationClass.mutate(fixture.content, seededRng(4));
          if (mutation === null) {
            throw new Error('mutate returned null although canApply passed');
          }
          const mutated = applyMutation(fixture.content, mutation);
          switch (mutationClass.name) {
            case 'identifier-rename': {
              expect(countWholeWord(mutated, mutation.mutatedSnippet)).toBe(1);
              expect(countWholeWord(mutated, mutation.originalSnippet)).toBe(
                countWholeWord(fixture.content, mutation.originalSnippet) - 1,
              );
              break;
            }
            case 'identifier-rename-multi': {
              expect(mutation.hunks?.length).toBe(3);
              expect(countWholeWord(mutated, mutation.mutatedSnippet)).toBe(3);
              expect(countWholeWord(mutated, mutation.originalSnippet)).toBe(
                countWholeWord(fixture.content, mutation.originalSnippet) - 3,
              );
              break;
            }
            case 'subtle-whitespace':
            case 'comment-swap':
            case 'boundary-splice': {
              expect(differingLines(fixture.content, mutated)).toBe(1);
              break;
            }
            case 'duplicate-line': {
              expect(mutated.split('\n').length).toBe(fixture.content.split('\n').length + 1);
              break;
            }
            case 'long-line-splice': {
              expect(countWholeWord(mutated, mutation.mutatedSnippet)).toBe(1);
              expect(mutated.length - fixture.content.length).toBe(
                mutation.mutatedSnippet.length - mutation.originalSnippet.length,
              );
              break;
            }
            case 'multi-hunk-double': {
              expect(mutation.parts?.length).toBe(2);
              expect(differingLines(fixture.content, mutated)).toBeLessThanOrEqual(2);
              break;
            }
            case 'external-shift': {
              expect(mutation.parts?.length).toBe(1);
              break;
            }
            default:
              throw new Error(`unhandled mutation class ${mutationClass.name}`);
          }
        });
      }
    });
  }

  it('instructions cite the recorded line numbers', () => {
    for (const mutationClass of MUTATION_CLASSES) {
      for (const fixture of EDIT_BENCH_FIXTURES) {
        if (!mutationClass.canApply(fixture.content)) continue;
        const mutation = mutationClass.mutate(fixture.content, seededRng(5));
        if (mutation === null) {
          throw new Error('mutate returned null although canApply passed');
        }
        const instruction = mutationClass.instruction(mutation, fixture.name);
        expect(instruction.length).toBeGreaterThan(0);
        if (mutation.line !== undefined) {
          expect(instruction).toContain(String(mutation.line));
        }
      }
    }
  });

  it('targets named in the instruction for token-level classes', () => {
    const tokenClasses = new Set([
      'identifier-rename',
      'identifier-rename-multi',
      'long-line-splice',
    ]);
    for (const mutationClass of MUTATION_CLASSES) {
      if (!tokenClasses.has(mutationClass.name)) continue;
      for (const fixture of EDIT_BENCH_FIXTURES) {
        if (!mutationClass.canApply(fixture.content)) continue;
        const mutation = mutationClass.mutate(fixture.content, seededRng(6));
        if (mutation === null) {
          throw new Error('mutate returned null although canApply passed');
        }
        expect(mutationClass.instruction(mutation, fixture.name)).toContain(
          mutation.mutatedSnippet,
        );
      }
    }
  });
});

describe('external-shift recovery', () => {
  const shiftClass = MUTATION_CLASSES.find((cls) => cls.name === 'external-shift');

  it('is part of the library', () => {
    expect(shiftClass).toBeDefined();
  });

  it.skipIf(shiftClass === undefined)(
    'expected content equals the shifted pristine fixture',
    () => {
      const mutationClass = shiftClass as MutationClass;
      for (const fixture of EDIT_BENCH_FIXTURES) {
        if (!mutationClass.canApply(fixture.content)) continue;
        for (const seed of SEEDS) {
          const mutation = mutationClass.mutate(fixture.content, seededRng(seed));
          if (mutation === null) {
            throw new Error('mutate returned null although canApply passed');
          }
          const shift = mutation.shift as ExternalShift;
          expect(shift.count).toBeGreaterThanOrEqual(1);
          expect(shift.count).toBeLessThanOrEqual(3);
          expect(mutation.parts?.length).toBe(1);
          const expected = expectedAfterFix(fixture.content, mutationClass, mutation);
          expect(expected).toEqual(applyExternalShift(fixture.content, shift));
        }
      }
    },
  );

  it.skipIf(shiftClass === undefined)(
    'skips recovery cases whose corrupted comment text has a twin after the shift',
    () => {
      const mutationClass = shiftClass as MutationClass;
      // Comment-only fixture: identifier-rename and subtle-whitespace cannot
      // apply (no code lines), so every attempt goes through comment-swap —
      // and every canned wrong-comment text is present, so whichever text
      // the corruption picks, the corrupted line's text occurs at least
      // twice in the post-shift content. The twin exclusion must drop the
      // case (mutate returns null; the run counts it as skipped) for every
      // seed.
      const fixture =
        [
          ...WRONG_COMMENT_TEXTS.map((text) => `// ${text}`),
          ...Array.from({ length: 18 }, () => ''),
        ].join('\n') + '\n';
      expect(mutationClass.canApply(fixture)).toBe(true);
      for (const seed of SEEDS) {
        expect(mutationClass.mutate(fixture, seededRng(seed))).toBeNull();
      }
    },
  );

  it.skipIf(shiftClass === undefined)(
    'still plans recovery cases when the corrupted comment text is unique',
    () => {
      const mutationClass = shiftClass as MutationClass;
      // Counterpart to the twin exclusion: no canned wrong-comment text is
      // present, so every corruption of the single comment line produces
      // text that occurs exactly once in the post-shift content — the
      // exclusion must not block these cases.
      const fixture =
        ['// a deliberately unique comment used by the twin-exclusion test.']
          .concat(Array.from({ length: 23 }, () => ''))
          .join('\n') + '\n';
      expect(mutationClass.canApply(fixture)).toBe(true);
      for (const seed of SEEDS) {
        expect(mutationClass.mutate(fixture, seededRng(seed))).not.toBeNull();
      }
    },
  );
});

describe('applyExternalShift', () => {
  it('inserts blank lines before the given line', () => {
    expect(applyExternalShift('a\nb\nc', { atLine: 2, count: 2, mode: 'insert' })).toEqual(
      'a\n\n\nb\nc',
    );
  });

  it('deletes lines from the given line', () => {
    expect(applyExternalShift('a\nb\nc\nd', { atLine: 2, count: 2, mode: 'delete' })).toEqual(
      'a\nd',
    );
  });
});

describe('planEditBenchmarkCases', () => {
  it('is deterministic for the same options', () => {
    const first = planEditBenchmarkCases({ maxCases: 6, seed: 7 });
    const second = planEditBenchmarkCases({ maxCases: 6, seed: 7 });
    expect(second.map((planned) => planned.mutationClass.name)).toEqual(
      first.map((planned) => planned.mutationClass.name),
    );
    expect(second.map((planned) => planned.fixture.name)).toEqual(
      first.map((planned) => planned.fixture.name),
    );
    expect(second.map((planned) => planned.seed)).toEqual(
      first.map((planned) => planned.seed),
    );
  });

  it('caps cases and keeps per-case seeds unique', () => {
    const full = planEditBenchmarkCases({});
    const capped = planEditBenchmarkCases({ maxCases: 6, seed: 7 });
    expect(capped.length).toBe(6);
    expect(full.length).toBeGreaterThan(6);
    const seeds = new Set(capped.map((planned) => planned.seed));
    expect(seeds.size).toBe(capped.length);
  });

  it('filters by category and drops unknown categories', () => {
    const recovery = planEditBenchmarkCases({ categories: ['recovery'] });
    expect(recovery.length).toBeGreaterThan(0);
    for (const planned of recovery) {
      expect(planned.mutationClass.category).toBe('recovery');
    }
    expect(planEditBenchmarkCases({ categories: ['no-such-category'] }).length).toBe(0);
  });
});

describe('runEditBenchmark', () => {
  it('assembles cases from the plan and aggregates results', async () => {
    runEvalPromptMock.mockReset();
    runEvalPromptMock.mockResolvedValue(CANNED_RESULT);
    const planOptions = { maxCases: 8, seed: 7 };
    const report = await runEditBenchmark({
      ...planOptions,
      model: 'test/model',
      screamHome: '/tmp/scream-home',
    });
    const plan = planEditBenchmarkCases(planOptions);
    expect(runEvalPromptMock).toHaveBeenCalledTimes(plan.length);
    expect(report.skipped).toBe(0);

    for (let i = 0; i < plan.length; i += 1) {
      const planned = plan[i];
      if (planned === undefined) throw new Error(`missing plan entry ${i}`);
      const mutation = planned.mutationClass.mutate(
        planned.fixture.content,
        seededRng(planned.seed),
      );
      if (mutation === null) throw new Error('mutate returned null although canApply passed');
      const { input, options, fixtures } = mockedCallAt(i);

      expect(options.model).toBe('test/model');
      expect(options.screamHome).toBe('/tmp/scream-home');

      expect(fixtures).toHaveLength(1);
      expect(fixtures[0]?.name).toBe(planned.fixture.name);
      expect(fixtures[0]?.content).toEqual(onDiskContent(planned.fixture.content, mutation));

      expect(options.verifyFileAfterTurn?.path).toBe(planned.fixture.name);
      expect(options.verifyFileAfterTurn?.content).toEqual(
        expectedAfterFix(planned.fixture.content, planned.mutationClass, mutation),
      );

      expect(input.prompt.startsWith(`In ${planned.fixture.name}: `)).toBe(true);
      expect(input.prompt).toContain('Use the Edit tool');
      expect(input.prompt).toContain('Do not rewrite the file');

      // Non-recovery fixes invert the mutation exactly: the expected file is
      // the pristine fixture. Recovery fixes are verified against the shift.
      if (planned.mutationClass.category === 'recovery') {
        const shift = mutation.shift as ExternalShift;
        expect(options.verifyFileAfterTurn?.content).toEqual(
          applyExternalShift(planned.fixture.content, shift),
        );
      } else {
        expect(options.verifyFileAfterTurn?.content).toEqual(planned.fixture.content);
      }
    }

    expect(report.results.length).toBe(plan.length);
    expect(report.passed).toBe(plan.length);
    expect(report.failed).toBe(0);
    expect(report.totalTokens).toBe(15 * plan.length);
    for (const [category, stat] of Object.entries(report.byCategory)) {
      const categoryTotal = report.results.filter((r) => r.category === category).length;
      expect(stat.passed + stat.failed).toBe(categoryTotal);
    }
  });

  it('honors category filters when running', async () => {
    runEvalPromptMock.mockReset();
    runEvalPromptMock.mockResolvedValue(CANNED_RESULT);
    const report = await runEditBenchmark({
      categories: ['recovery'],
      maxCases: 4,
      seed: 5,
      model: 'test/model',
    });
    expect(report.results.length).toBeGreaterThan(0);
    expect(report.results.length).toBeLessThanOrEqual(4);
    for (const result of report.results) {
      expect(result.category).toBe('recovery');
    }
  });

  it('counts unverified files and harness errors as failures', async () => {
    runEvalPromptMock.mockReset();
    runEvalPromptMock
      .mockResolvedValueOnce({ ...CANNED_RESULT, verifiedFile: false })
      .mockRejectedValueOnce(new Error('provider unreachable'))
      .mockResolvedValue(CANNED_RESULT);
    const report = await runEditBenchmark({ maxCases: 5, seed: 11, model: 'test/model' });
    expect(report.results.length).toBe(5);
    expect(report.failed).toBe(2);
    const failed = report.results.filter((result) => !result.passed);
    expect(failed[0]?.verifiedFile).toBe(false);
    expect(failed[1]?.error).toBe('provider unreachable');
    expect(failed[1]?.timedOut).toBe(false);
  });

  it('never passes a case whose turn timed out', async () => {
    runEvalPromptMock.mockReset();
    runEvalPromptMock.mockResolvedValue({ ...CANNED_RESULT, timedOut: true });
    const report = await runEditBenchmark({ maxCases: 3, seed: 3, model: 'test/model' });
    expect(report.results.length).toBe(3);
    expect(report.passed).toBe(0);
    expect(report.failed).toBe(3);
    for (const result of report.results) {
      expect(result.timedOut).toBe(true);
    }
  });

  it('runs cases strictly sequentially', async () => {
    runEvalPromptMock.mockReset();
    let inFlight = 0;
    let maxInFlight = 0;
    runEvalPromptMock.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      await Promise.resolve();
      inFlight -= 1;
      return CANNED_RESULT;
    });
    await runEditBenchmark({ maxCases: 5, seed: 2, model: 'test/model' });
    expect(maxInFlight).toBe(1);
  });
});
