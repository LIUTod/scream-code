/**
 * Cold-start repository comprehension eval.
 *
 * Measures how expensively the agent answers "where/why" questions about an
 * unfamiliar multi-module codebase: input tokens, output tokens, and whether
 * the answer names the right module. The fixture is a tiny workspace with
 * three interdependent modules whose responsibilities cannot be guessed from
 * names alone (the retry logic lives in `scheduler`, not in `network`).
 *
 * Run manually (not wired into CI — the zg A/B variant needs a local daemon
 * and a pre-built index):
 *
 *   SCREAM_EVAL_MODEL=provider/model pnpm -C packages/evals run eval
 *   npx vitest run packages/evals/src/cold-start.eval.ts
 *
 * Baseline results are recorded in `results/cold-start.md`.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runEvalPrompt } from './harness';

const RETRY_MODULE_CONTENT = `/**
 * Retry scheduling for outbound jobs.
 *
 * Design note: retries deliberately live here instead of the network layer so
 * that queue backoffs and network backoffs never fight over the same socket
 * timeout budget.
 */
export class RetryScheduler {
  private attempts = new Map<string, number>();
  constructor(private readonly maxAttempts = 5) {}
  shouldRetry(jobId: string): boolean {
    const n = this.attempts.get(jobId) ?? 0;
    return n < this.maxAttempts;
  }
  recordAttempt(jobId: string): void {
    this.attempts.set(jobId, (this.attempts.get(jobId) ?? 0) + 1);
  }
}
`;

const NETWORK_MODULE_CONTENT = `import { RetryScheduler } from '../scheduler/retry';

/** Outbound HTTP client. Retry decisions are delegated to the scheduler. */
export class HttpClient {
  constructor(private readonly retry = new RetryScheduler()) {}
  async send(jobId: string, url: string): Promise<string> {
    for (;;) {
      try {
        return await fetchUrl(url);
      } catch {
        if (!this.retry.shouldRetry(jobId)) throw new Error('gave up: ' + jobId);
        this.retry.recordAttempt(jobId);
      }
    }
  }
}

async function fetchUrl(url: string): Promise<string> {
  return 'ok:' + url;
}
`;

const QUEUE_MODULE_CONTENT = `import { HttpClient } from '../network/http';

/** Job queue: owns job state; delivery goes through the network client. */
export class JobQueue {
  private readonly pending: string[] = [];
  constructor(private readonly client = new HttpClient()) {}
  enqueue(jobId: string): void {
    this.pending.push(jobId);
  }
  async drain(): Promise<string[]> {
    const results: string[] = [];
    for (const job of this.pending.splice(0)) {
      results.push(await this.client.send(job, 'https://example.invalid/' + job));
    }
    return results;
  }
}
`;

const FIXTURES = [
  { name: 'README.md', content: '# Sample service\n\nThree modules: queue (jobs), network (http), scheduler (retry policy).\n' },
  { name: 'src/queue/jobs.ts', content: QUEUE_MODULE_CONTENT },
  { name: 'src/network/http.ts', content: NETWORK_MODULE_CONTENT },
  { name: 'src/scheduler/retry.ts', content: RETRY_MODULE_CONTENT },
] as const;

const RETRY_QUESTION =
  'This repository handles background job delivery. ' +
  'Answer two things: (1) which module decides whether a failed job should be retried, ' +
  'and (2) why is that decision kept out of the HTTP layer? ' +
  'Cite the file paths you relied on. Reply in under 120 words.';

/**
 * The shared harness writes fixtures with plain `writeFile` and does not
 * create parent directories, so this eval writes its nested fixture tree
 * itself and passes the prepared `workDir` to the harness (which cleans up
 * caller-provided dirs are left alone; we remove our own temp dir below).
 */
async function writeColdStartFixtures(workDir: string): Promise<void> {
  for (const fixture of FIXTURES) {
    const filePath = join(workDir, fixture.name);
    await mkdir(join(filePath, '..'), { recursive: true });
    await writeFile(filePath, fixture.content, 'utf-8');
  }
}

describe('cold-start repo comprehension eval', () => {
  it('locates the retry owner and its design rationale', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'scream-eval-coldstart-'));
    await writeColdStartFixtures(workDir);
    try {
      const result = await runEvalPrompt({ prompt: RETRY_QUESTION }, { workDir, thinking: 'low' });
      expect(result.timedOut).toBe(false);
      expect(result.usage.totalTokens).toBeGreaterThan(0);
      // The retry logic intentionally lives in scheduler/, not network/.
      expect(result.output).toMatch(/scheduler/i);
      // Design rationale is only discoverable from the source comment.
      expect(result.output.toLowerCase()).toMatch(/socket|timeout|backoff|budget/);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});
