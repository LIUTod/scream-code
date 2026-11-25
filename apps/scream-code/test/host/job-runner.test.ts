import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { JobStore, type Event, type Job, type ScreamHarness, type Session } from '@scream-code/scream-code-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  briefHasNothingToReport,
  JOB_RETRY_DELAY_MS,
  JOB_RUN_SESSION_PREFIX,
  JOB_TRANSIENT_RETRIES,
  jobIdOfRunSession,
  JobRunner,
  NOTHING_TO_REPORT,
  renderJobPrompt,
} from '#/host/job-runner';

const homes: string[] = [];
afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'job-runner-'));
  homes.push(dir);
  return dir;
}

const NOW = new Date(2026, 10, 18, 9, 0).getTime();

interface FakeOptions {
  readonly reply?: string;
  readonly reason?: 'completed' | 'failed';
  /** The error `turn.ended` carries (a failed turn). */
  readonly error?: Record<string, unknown>;
}

function fakeHarness(options: FakeOptions = {}) {
  const prompts: string[] = [];
  const created: Array<Record<string, unknown>> = [];
  const harness = {
    createSession: vi.fn(async (input: Record<string, unknown>) => {
      created.push(input);
      const listeners = new Set<(event: Event) => void>();
      const emit = (event: Record<string, unknown>): void => {
        for (const listener of listeners) listener({ agentId: 'main', sessionId: input['id'], ...event } as unknown as Event);
      };
      return {
        id: input['id'] as string,
        onEvent(listener: (event: Event) => void) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        async prompt(text: string) {
          prompts.push(text);
          setTimeout(() => {
            emit({ type: 'turn.started' });
            emit({ type: 'assistant.delta', delta: options.reply ?? 'All green.' });
            emit({
              type: 'turn.ended',
              reason: options.reason ?? 'completed',
              ...(options.error === undefined ? {} : { error: options.error }),
            });
          }, 1);
        },
        async createGoal() {
          return {};
        },
        async getGoal() {
          return { goal: null };
        },
        async close() {},
      } as unknown as Session;
    }),
    deleteSession: vi.fn(async () => {}),
  };
  return { harness: harness as unknown as ScreamHarness & typeof harness, prompts, created };
}

const messages = {
  firstFailure: (job: Job, summary: string) => `FAIL ${job.title}: ${summary}`,
  fatigued: (job: Job) => `OFF ${job.title}`,
  result: (job: Job, summary: string) => `OK ${job.title}: ${summary}`,
  branch: (branch: string) => `BRANCH ${branch}`,
};

async function addDueJob(dir: string, deliverTo?: string): Promise<Job> {
  return new JobStore(dir).add(
    {
      title: 'CI',
      prompt: 'check CI',
      starts: { kind: 'cron', cron: '0 9 * * *' },
      workDir: '/w',
      createdBy: 'person',
      ...(deliverTo === undefined ? {} : { deliverTo }),
    },
    NOW - 60_000,
  );
}

async function waitIdle(runner: JobRunner): Promise<void> {
  for (let i = 0; i < 400 && runner.busy(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
}

describe('JobRunner', () => {
  it('runs a due job in a fresh job-run session, records its answer, and sends it to its chat', async () => {
    const dir = home();
    const job = await addDueJob(dir, 'line-feishu-x');
    const { harness, prompts, created } = fakeHarness({ reply: 'CI is green.' });
    const deliver = vi.fn(async () => {});
    const runner = new JobRunner({ harness, useWorktrees: false, screamHomeDir: dir, deliver, messages, now: () => NOW });

    expect(await runner.tick()).toBe(1);
    await waitIdle(runner);

    expect(created[0]).toMatchObject({ workDir: '/w', permission: 'bot', metadata: { source: 'job', jobId: job.id } });
    expect(String(created[0]!['id'])).toMatch(new RegExp(`^${JOB_RUN_SESSION_PREFIX}${job.id}-`));
    expect(prompts[0]).toContain('<task>\ncheck CI\n</task>');
    const after = new JobStore(dir).get(job.id)!;
    expect(after.runs).toHaveLength(1);
    expect(after.runs[0]).toMatchObject({ ok: true, summary: 'CI is green.' });
    expect(after.notes).toBe('CI is green.');
    expect(after.nextRunAt).toBeGreaterThan(NOW);
    expect(deliver).toHaveBeenCalledWith('line-feishu-x', 'OK CI: CI is green.');
  });

  it('reports the first failure once, not every failure', async () => {
    const dir = home();
    const job = await addDueJob(dir, 'line-weixin-y');
    const { harness } = fakeHarness({ reason: 'failed', reply: 'boom' });
    const deliver = vi.fn(async () => {});
    let now = NOW;
    const runner = new JobRunner({ harness, useWorktrees: false, screamHomeDir: dir, deliver, messages, now: () => now });

    await runner.tick();
    await waitIdle(runner);
    now += 24 * 3600_000;
    await runner.tick();
    await waitIdle(runner);

    expect(new JobStore(dir).get(job.id)!.consecutiveFailures).toBe(2);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith('line-weixin-y', 'FAIL CI: boom');
  });

  it('passes the previous run notes to the next run, and reports-only runs in ask mode', async () => {
    const dir = home();
    const store = new JobStore(dir);
    const job = await store.add(
      { title: 'look', prompt: 'look around', starts: { kind: 'cron', cron: '0 9 * * *' }, does: 'report', workDir: '/w', createdBy: 'person' },
      NOW - 60_000,
    );
    await store.recordRun(job.id, { at: NOW - 86_400_000, ok: true, sessionId: 's0', summary: 'x', notes: 'remember the flaky test' }, NOW - 120_000);
    // recordRun moved nextRunAt forward from NOW-120000 → today 09:00, which is due at NOW.
    const { harness, prompts, created } = fakeHarness();
    const runner = new JobRunner({ harness, useWorktrees: false, screamHomeDir: dir, messages, now: () => NOW });
    await runner.tick();
    await waitIdle(runner);
    expect(created[0]).toMatchObject({ permission: 'ask' });
    expect(prompts[0]).toContain('<notes-from-last-run>\nremember the flaky test\n</notes-from-last-run>');
  });

  it('coalesces windows missed while no host ran into one run that says how many', async () => {
    const dir = home();
    const job = await addDueJob(dir);
    const { harness, prompts } = fakeHarness();
    const later = NOW + 3 * 24 * 3600_000 + 3600_000;
    const runner = new JobRunner({ harness, useWorktrees: false, screamHomeDir: dir, messages, now: () => later });
    await runner.start(60_000);
    runner.stop();
    await waitIdle(runner);
    expect(harness.createSession).toHaveBeenCalledTimes(1);
    expect(prompts[0]).toMatch(/<missed-runs count="\d+">/);
    const after = new JobStore(dir).get(job.id)!;
    expect(after.nextRunAt).toBeGreaterThan(later);
    expect(after.missedRuns).toBeUndefined();
  });

  it('skips windows missed too long ago and notes them for the brief', async () => {
    const dir = home();
    const job = await new JobStore(dir).add(
      { title: 'once', prompt: 'p', starts: { kind: 'once', at: NOW }, workDir: '/w', createdBy: 'person' },
      NOW - 60_000,
    );
    const { harness } = fakeHarness();
    const later = NOW + 3 * 24 * 3600_000;
    const runner = new JobRunner({ harness, useWorktrees: false, screamHomeDir: dir, messages, now: () => later });
    await runner.start(60_000);
    runner.stop();
    await waitIdle(runner);
    expect(harness.createSession).not.toHaveBeenCalled();
    const after = new JobStore(dir).get(job.id)!;
    expect(after.lastSkipped).toEqual({ count: 1, at: later });
    const { renderSkippedBlock } = await import('#/host/job-runner');
    expect(renderSkippedBlock([after], later + 1000)).toContain('once: 1 run(s) skipped');
    expect(renderSkippedBlock([after], later + 2 * 86_400_000)).toBeUndefined();
  });
});

describe('renderJobPrompt', () => {
  it('frames the run as work to do now', () => {
    const prompt = renderJobPrompt(
      { id: 'job-1', prompt: 'do it', notes: '', does: 'act' } as unknown as Job,
      NOW,
    );
    expect(prompt).toContain('This is a scheduled background task running now');
    expect(prompt).not.toContain('notes-from-last-run');
  });
});

describe('renderWaitingBlock', () => {
  it('lists what still waits and what expired in the last day', async () => {
    const { renderWaitingBlock } = await import('#/host/job-runner');
    const now = Date.now();
    const base = { sessionId: 's', workDir: '/w', createdAt: now - 1000 };
    const block = renderWaitingBlock(
      [
        { ...base, id: 'inbox-1', kind: 'approval', status: 'pending', expiresAt: now + 1000, approval: { tool: 'Bash', action: 'git push', key: 'k', reason: '' } },
        { ...base, id: 'inbox-2', kind: 'approval', status: 'expired', expiresAt: now - 1000, approval: { tool: 'Bash', action: 'rm -rf dist', key: 'k2', reason: '' } },
        { ...base, id: 'inbox-3', kind: 'approval', status: 'expired', expiresAt: now - 3 * 86_400_000, approval: { tool: 'Bash', action: 'old', key: 'k3', reason: '' } },
      ],
      now,
    );
    expect(block).toContain('still waiting (inbox-1');
    expect(block).toContain('expired unanswered (inbox-2');
    expect(block).not.toContain('old');
    expect(renderWaitingBlock([], now)).toBeUndefined();
  });
});

describe('JobRunner run hooks', () => {
  it('adds prepared context to the prompt and calls afterRun before recording', async () => {
    const dir = home();
    await addDueJob(dir);
    const { harness, prompts } = fakeHarness({ reply: 'Proposed 2 changes.' });
    const after: string[] = [];
    const runner = new JobRunner({
      harness,
      useWorktrees: false,
      screamHomeDir: dir,
      messages,
      now: () => NOW,
      prepareRun: async () => ({ context: '<tool-friction>x</tool-friction>', noWorktree: true }),
      afterRun: async (_job, run) => {
        after.push(run.summary);
      },
    });
    await runner.tick();
    await waitIdle(runner);
    expect(prompts[0]).toContain('<tool-friction>x</tool-friction>');
    expect(after).toEqual(['Proposed 2 changes.']);
  });
});

describe('self-review job', () => {
  it('is made report-only, can switch tier keeping its runs, and is recognized', async () => {
    const { addSelfReviewJob, isSelfReviewJob, selfReviewPrompt } = await import('#/host/self-review');
    const dir = home();
    const job = await addSelfReviewJob(dir);
    expect(job).toMatchObject({ does: 'report', starts: { kind: 'cron', cron: '0 8 * * 1' } });
    expect(job.prompt).toContain('Change nothing');
    expect(isSelfReviewJob(job)).toBe(true);
    const switched = await new JobStore(dir).setDoes(job.id, 'act', selfReviewPrompt('act'));
    expect(switched.does).toBe('act');
    expect(switched.prompt).toContain('Make small changes yourself');
    expect(isSelfReviewJob(switched)).toBe(true);
  });
});

describe('results of a job made in a terminal', () => {
  it('go to the chat the person last wrote from when the job names none', async () => {
    const dir = home();
    await addDueJob(dir);
    const { harness } = fakeHarness({ reply: 'CI is green.' });
    const deliver = vi.fn(async (_key: string, _text: string) => {});
    const runner = new JobRunner({
      harness,
      useWorktrees: false,
      screamHomeDir: dir,
      deliver,
      messages,
      now: () => NOW,
      fallbackChat: () => 'line-weixin-me',
    });
    await runner.tick();
    await waitIdle(runner);
    expect(deliver).toHaveBeenCalledWith('line-weixin-me', expect.stringContaining('CI is green.'));
  });
});

describe('JobRunner — a failure that produced no answer', () => {
  it('records why, instead of an empty summary', async () => {
    const dir = home();
    const job = await addDueJob(dir, 'line-weixin-z');
    const { harness } = fakeHarness({ reason: 'failed', reply: '' });
    const deliver = vi.fn(async () => {});
    const runner = new JobRunner({ harness, useWorktrees: false, screamHomeDir: dir, deliver, messages, now: () => NOW });

    expect(await runner.tick()).toBe(1);
    await waitIdle(runner);

    const after = new JobStore(dir).get(job.id)!;
    // `ok: false` with an empty summary was recorded for a real run that failed
    // after 8½ minutes: nothing to act on, and the next run inherited the void.
    expect(after.runs[0]).toMatchObject({
      ok: false,
      summary: "(Run failed without an answer: the turn ended with reason 'failed')",
    });
  });
});

describe('JobRunner — a failure that clears by itself', () => {
  const timeout = { code: 'provider.timeout', message: 'Request timed out.', retryable: true };

  it('tries again shortly instead of recording a failure, and says nothing yet', async () => {
    const dir = home();
    const job = await addDueJob(dir, 'line-feishu-r');
    const { harness } = fakeHarness({ reason: 'failed', reply: '', error: timeout });
    const deliver = vi.fn(async () => {});
    const onRun = vi.fn();
    const onRetry = vi.fn();
    const runner = new JobRunner({
      harness,
      useWorktrees: false,
      screamHomeDir: dir,
      deliver,
      messages,
      onRun,
      onRetry,
      now: () => NOW,
    });

    await runner.tick();
    await waitIdle(runner);

    const after = new JobStore(dir).get(job.id)!;
    expect(after).toMatchObject({ consecutiveFailures: 0, retries: 1, nextRunAt: NOW + JOB_RETRY_DELAY_MS });
    expect(after.runs[0]).toMatchObject({
      ok: false,
      retrying: true,
      summary: '(Run failed without an answer: Request timed out. [provider.timeout])',
    });
    expect(deliver).not.toHaveBeenCalled();
    expect(onRun).not.toHaveBeenCalled();
    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }), NOW + JOB_RETRY_DELAY_MS);
  });

  it(`counts it as a failure once ${String(JOB_TRANSIENT_RETRIES)} retries did not help`, async () => {
    const dir = home();
    const job = await addDueJob(dir, 'line-feishu-r');
    const { harness } = fakeHarness({ reason: 'failed', reply: '', error: timeout });
    const deliver = vi.fn(async () => {});
    let now = NOW;
    const runner = new JobRunner({ harness, useWorktrees: false, screamHomeDir: dir, deliver, messages, now: () => now });

    for (let attempt = 0; attempt <= JOB_TRANSIENT_RETRIES; attempt++) {
      await runner.tick();
      await waitIdle(runner);
      now += JOB_RETRY_DELAY_MS;
    }

    const after = new JobStore(dir).get(job.id)!;
    expect(after.runs).toHaveLength(JOB_TRANSIENT_RETRIES + 1);
    expect(after.consecutiveFailures).toBe(1);
    expect(after.retries).toBeUndefined();
    expect(deliver).toHaveBeenCalledTimes(1);
    // Three runs, each waiting the real settle window.
  }, 15_000);

  it('does not retry a failure that needs the person', async () => {
    const dir = home();
    const job = await addDueJob(dir);
    const { harness } = fakeHarness({
      reason: 'failed',
      reply: '',
      error: { code: 'provider.auth_error', message: 'Invalid API key', retryable: false },
    });
    const runner = new JobRunner({ harness, useWorktrees: false, screamHomeDir: dir, messages, now: () => NOW });

    await runner.tick();
    await waitIdle(runner);

    expect(new JobStore(dir).get(job.id)).toMatchObject({ consecutiveFailures: 1 });
  });
});

describe('a report with nothing to report', () => {
  it('is recorded as done without a session or a model call, and sends nothing', async () => {
    const dir = home();
    const job = await new JobStore(dir).add(
      { title: '每日简报', prompt: 'brief', starts: { kind: 'cron', cron: '0 9 * * *' }, does: 'report', workDir: '/w', createdBy: 'person', deliverTo: 'line-feishu-x' },
      NOW - 60_000,
    );
    const { harness } = fakeHarness();
    const deliver = vi.fn(async () => {});
    const onRun = vi.fn();
    const runner = new JobRunner({
      harness,
      useWorktrees: false,
      screamHomeDir: dir,
      deliver,
      messages,
      onRun,
      nothingToReport: () => true,
      now: () => NOW,
    });

    await runner.tick();
    await waitIdle(runner);

    expect(harness.createSession).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
    expect(onRun).not.toHaveBeenCalled();
    const after = new JobStore(dir).get(job.id)!;
    expect(after.runs[0]).toMatchObject({ ok: true, sessionId: '', summary: NOTHING_TO_REPORT });
    expect(after.nextRunAt).toBeGreaterThan(NOW);
  });
});

describe('briefHasNothingToReport', () => {
  const brief = { title: '每日简报' } as Job;
  const base = { job: brief, since: 0, now: NOW, activity: [], inbox: [], jobs: [] };

  it('is true when the only thing that happened is the brief itself', () => {
    expect(briefHasNothingToReport({ ...base, activity: [{ kind: 'job', title: '每日简报' }] })).toBe(true);
  });

  it('is false when other work ran or something waits', () => {
    expect(briefHasNothingToReport({ ...base, activity: [{ kind: 'continued', title: '修复' }] })).toBe(false);
    expect(briefHasNothingToReport({ ...base, activity: [{ kind: 'health', title: '后台反复崩溃' }] })).toBe(false);
  });
});

describe('jobIdOfRunSession', () => {
  it('reads the job a run session belongs to', () => {
    expect(jobIdOfRunSession('job-run-job-c2fe237b-64684892')).toBe('job-c2fe237b');
    expect(jobIdOfRunSession('ses-123')).toBeUndefined();
  });
});
