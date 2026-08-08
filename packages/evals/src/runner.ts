/**
 * Programmatic entry point for the end-to-end evals. Runs the same scenarios
 * as the vitest eval files (smoke + regression) but returns structured
 * results instead of throwing, so the TUI `/eval` command can render a
 * per-case report. The vitest runs in `smoke.eval.ts` / `regression.eval.ts`
 * stay as-is for CI/`pnpm eval` usage.
 */

import { judgeOutput, type JudgeRule } from './judge';
import { runEvalPrompt, type EvalRunInput } from './harness';

const FIXTURE_CONTENT = 'The quick brown fox jumps over the lazy dog.';

export interface EvalCase {
  /** Stable id used for reporting. */
  readonly id: string;
  /** Human-readable case name. */
  readonly name: string;
  readonly input: EvalRunInput | string;
  readonly rules: readonly JudgeRule[];
  /** Extra assertions beyond the judge rules (e.g. usage > 0). */
  readonly extra?: (result: Awaited<ReturnType<typeof runEvalPrompt>>) => string[];
  /** Side-effect file to verify after the turn (write-file case). */
  readonly verifyFile?: { readonly path: string; readonly content: string };
}

export interface EvalCaseResult {
  readonly id: string;
  readonly name: string;
  readonly passed: boolean;
  readonly failedRules: readonly string[];
  readonly passedRules: readonly string[];
  readonly extraFailures: readonly string[];
  readonly output: string;
  readonly error?: string;
  /** True when the turn hit the timeout instead of ending naturally. */
  readonly timedOut: boolean;
  /** True when the case has a side-effect file check and the file was not
   *  created with the expected content (a tool-chain problem, not a model
   *  answer problem). */
  readonly toolCheckFailed: boolean;
}

export interface EvalRunOptions {
  /** Model selector, e.g. `provider/model`. */
  readonly model?: string;
  /** Called after each case finishes so the UI can show live progress. */
  readonly onProgress?: (progress: {
    readonly completed: number;
    readonly total: number;
    readonly currentId: string;
    readonly currentName: string;
    readonly passed: number;
    readonly failed: number;
  }) => void;
}

export interface EvalSummary {
  readonly results: readonly EvalCaseResult[];
  readonly passed: number;
  readonly failed: number;
}

export const EVAL_CASES: readonly EvalCase[] = [
  {
    id: 'smoke',
    name: 'Smoke — answers a trivial question',
    input: 'What is the capital of France? Answer in one word.',
    rules: [
      {
        name: 'answers the capital',
        check: (output) => {
          const lower = output.toLowerCase();
          return lower.includes('paris') || lower.includes('巴黎');
        },
      },
    ],
    extra: (result) => {
      const failures: string[] = [];
      if (result.usage.totalTokens <= 0) failures.push('usage.totalTokens must be > 0');
      if (result.usage.model.length === 0) failures.push('usage.model must be non-empty');
      return failures;
    },
  },
  {
    id: 'read-file',
    name: 'Regression — reads a file via the Read tool',
    input: {
      prompt:
        'Read the file data.txt in the current directory using the Read tool, then tell me what it contains.',
      fixtures: [{ name: 'data.txt', content: FIXTURE_CONTENT }],
    },
    rules: [
      {
        name: 'reports file content',
        check: (output) => output.includes('quick brown fox'),
      },
    ],
  },
  {
    id: 'write-file',
    name: 'Regression — writes a file via the Write tool',
    input: {
      prompt:
        'Create a file named output.txt in the current directory using the Write tool. ' +
        'Write exactly the text: hello eval world. ' +
        'Make exactly one Write tool call and do not call any other tool afterwards. ' +
        'After the tool completes, immediately answer with the exact text you wrote and nothing else.',
    },
    rules: [
      {
        name: 'Write tool landed the file',
        check: (output) => output.includes('hello eval world'),
      },
    ],
    verifyFile: { path: 'output.txt', content: 'hello eval world' },
    extra: (result) => {
      const failures: string[] = [];
      // The core capability is the Write tool actually creating the file with
      // the exact content. Some models loop after the Write call instead of
      // ending the turn; the file verification still proves the tool worked.
      if (!result.verifiedFile) {
        failures.push('output.txt was not created with the exact content');
      }
      return failures;
    },
  },
  {
    id: 'isolated-workspace',
    name: 'Regression — runs in an isolated temp workspace',
    input: {
      prompt:
        'Run "pwd" in a shell and answer with only the absolute path that the command printed.',
      fixtures: [{ name: 'marker.txt', content: 'isolated' }],
    },
    rules: [
      {
        name: 'prints an absolute path',
        check: (output) =>
          output.match(/(?:\/[\w.\-/]+|[A-Za-z]:[\\/][\w.\\/-]*)/)?.[0] !== undefined,
      },
      {
        name: 'path is not the repo',
        check: (output) =>
          !output.match(/(?:\/[\w.\-/]+|[A-Za-z]:[\\/][\w.\\/-]*)/)?.[0]?.includes(
            'scream-code',
          ),
      },
    ],
  },
];

/** Runs every eval case sequentially and returns a structured report. */
export async function runAllEvals(options: EvalRunOptions = {}): Promise<EvalSummary> {
  const results: EvalCaseResult[] = [];
  let passedCount = 0;
  let failedCount = 0;
  for (const caseDef of EVAL_CASES) {
    let result: Awaited<ReturnType<typeof runEvalPrompt>>;
    try {
      result = await runEvalPrompt(caseDef.input, {
        model: options.model,
        verifyFileAfterTurn: caseDef.verifyFile,
      });
    } catch (error) {
      results.push({
        id: caseDef.id,
        name: caseDef.name,
        passed: false,
        failedRules: [],
        passedRules: [],
        extraFailures: [],
        output: '',
        error: error instanceof Error ? error.message : String(error),
        timedOut: false,
        toolCheckFailed: false,
      });
      failedCount += 1;
      options.onProgress?.({
        completed: results.length,
        total: EVAL_CASES.length,
        currentId: caseDef.id,
        currentName: caseDef.name,
        passed: passedCount,
        failed: failedCount,
      });
      continue;
    }

    const judged = judgeOutput(result.output, caseDef.rules);
    const extraFailures = caseDef.extra?.(result) ?? [];
    const passed = judged.failed.length === 0 && extraFailures.length === 0;
    if (passed) {
      passedCount += 1;
    } else {
      failedCount += 1;
    }
    // A side-effect file check that failed means the tool chain itself
    // didn't land (e.g. Write did not create the file) — distinct from a
    // wrong model answer.
    const toolCheckFailed =
      caseDef.verifyFile !== undefined && !result.verifiedFile;
    results.push({
      id: caseDef.id,
      name: caseDef.name,
      passed,
      failedRules: judged.failed,
      passedRules: judged.passed,
      extraFailures,
      output: result.output,
      timedOut: result.timedOut,
      toolCheckFailed,
    });
    options.onProgress?.({
      completed: results.length,
      total: EVAL_CASES.length,
      currentId: caseDef.id,
      currentName: caseDef.name,
      passed: passedCount,
      failed: failedCount,
    });
  }

  return {
    results,
    passed: passedCount,
    failed: failedCount,
  };
}
