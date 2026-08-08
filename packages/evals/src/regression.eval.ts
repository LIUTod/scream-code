/**
 * Regression evals guarding core agent capabilities end-to-end:
 *  - tool-call pairing: an assistant `Read` call must be answered by a tool
 *    result and the model must surface the file content (this exercised the
 *    exact code path that previously failed after network interruptions with
 *    "insufficient tool messages following tool_calls message").
 *  - multi-step tool chain: write a file, then read it back.
 *
 * Run with: `pnpm eval` (repo root) or `pnpm -C packages/evals run eval`.
 * Model selection: `SCREAM_EVAL_MODEL` env var.
 */

import { describe, expect, it } from 'vitest';

import { runEvalPrompt } from './harness';
import { assertEvalPassed, contains, judgeOutput } from './judge';

const FIXTURE_CONTENT = 'The quick brown fox jumps over the lazy dog.';

describe('scream regression evals', () => {
  it('reads a file via the Read tool and reports its content', async () => {
    const result = await runEvalPrompt({
      prompt:
        'Read the file data.txt in the current directory using the Read tool, then tell me what it contains.',
      fixtures: [{ name: 'data.txt', content: FIXTURE_CONTENT }],
    });

    // The model must have actually read the file (tool-call path worked) and
    // reported the content back (output path worked).
    assertEvalPassed(judgeOutput(result.output, [contains('quick brown fox')]));
  });

  it('writes a file through the Write tool', async () => {
    // The core capability is the Write tool actually creating the file with
    // the exact content. Some models loop after the Write call instead of
    // ending the turn; the file verification still proves the tool worked,
    // so we assert on `verifiedFile` (plus the answer when it arrived).
    const result = await runEvalPrompt(
      {
        prompt:
          'Create a file named output.txt in the current directory using the Write tool. ' +
          'Write exactly the text: hello eval world. ' +
          'Make exactly one Write tool call and do not call any other tool afterwards. ' +
          'After the tool completes, immediately answer with the exact text you wrote and nothing else.',
      },
      { verifyFileAfterTurn: { path: 'output.txt', content: 'hello eval world' } },
    );

    expect(result.verifiedFile).toBe(true);
    expect(result.output.includes('hello eval world')).toBe(true);
  });

  it('runs in an isolated temp workspace', async () => {
    // The eval harness must run in an isolated temp workspace — the real
    // scream-code checkout must not leak into the session. Require both a
    // non-empty answer (proves the shell ran) and the absence of the repo
    // path (proves the cwd is isolated).
    const result = await runEvalPrompt({
      prompt:
        'Run "pwd" in a shell and answer with only the absolute path that the command printed.',
      fixtures: [{ name: 'marker.txt', content: 'isolated' }],
    });
    // Extract the first absolute path-like token so the assertion tolerates
    // the model quoting or prefixing its answer.
    const path = result.output.match(/(?:\/[\w.\-/]+|[A-Za-z]:[\\/][\w.\\/-]*)/)?.[0];
    expect(path).toBeDefined();
    expect(path).not.toContain('scream-code');
  });
});
