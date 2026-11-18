import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { JobStore } from '../../../src/jobs/store';
import type {
  ExecutableToolErrorResult,
  ExecutableToolResult,
  RunnableToolExecution,
  ToolExecution,
} from '../../../src/loop/types';
import {
  JobCreateTool,
  JobDeleteTool,
  JobListTool,
  type JobToolContext,
} from '../../../src/tools/jobs/job-tools';

const homes: string[] = [];
afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const NOW = new Date(2026, 10, 18, 8, 0).getTime();

function context(sessionId = 'session_abc'): JobToolContext {
  const dir = mkdtempSync(join(tmpdir(), 'job-tools-'));
  homes.push(dir);
  return { screamHomeDir: dir, workDir: () => '/w/project', sessionId, now: () => NOW };
}

function isError(execution: ToolExecution): execution is ExecutableToolErrorResult {
  return (execution as RunnableToolExecution).execute === undefined;
}

async function run(execution: ToolExecution): Promise<ExecutableToolResult> {
  if (isError(execution)) return execution;
  return execution.execute({ turnId: 't', toolCallId: 'c', signal: new AbortController().signal });
}

function text(result: ExecutableToolResult): string {
  return typeof result.output === 'string' ? result.output : JSON.stringify(result.output);
}

describe('JobCreate', () => {
  it('creates an agent task in the store and says the host is not running', async () => {
    const ctx = context();
    const result = await run(
      new JobCreateTool(ctx).resolveExecution({
        title: 'CI check',
        prompt: 'check CI and report what broke',
        cron: '3 9 * * 1-5',
        report_only: true,
      }),
    );
    expect(result.isError).not.toBe(true);
    expect(text(result)).toContain('host: not running yet');
    const [job] = new JobStore(ctx.screamHomeDir).list();
    expect(job).toMatchObject({
      title: 'CI check',
      createdBy: 'agent',
      does: 'report',
      workDir: '/w/project',
      starts: { kind: 'cron', cron: '3 9 * * 1-5' },
    });
    expect(job?.deliverTo).toBeUndefined();
  });

  it('refuses a schedule tighter than 15 minutes', async () => {
    const result = await run(
      new JobCreateTool(context()).resolveExecution({ title: 't', prompt: 'p', cron: '*/5 * * * *' }),
    );
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('at most every 15 minutes');
  });

  it('turns "in" into a one-off run, and a done_when into an outcome', async () => {
    const ctx = context();
    await run(
      new JobCreateTool(ctx).resolveExecution({ title: 't', prompt: 'fix it', in: '2h', done_when: 'tests pass' }),
    );
    const [job] = new JobStore(ctx.screamHomeDir).list();
    expect(job?.starts).toEqual({ kind: 'once', at: NOW + 2 * 3600_000 });
    expect(job?.until).toEqual({ kind: 'outcome', criterion: 'tests pass' });
  });

  it('sends results back to the chat a channel session created it from', async () => {
    const ctx = context('line-weixin-abc123');
    await run(new JobCreateTool(ctx).resolveExecution({ title: 't', prompt: 'p', cron: '0 9 * * *' }));
    expect(new JobStore(ctx.screamHomeDir).list()[0]?.deliverTo).toBe('line-weixin-abc123');
  });

  it('wants exactly one schedule', async () => {
    const result = await run(
      new JobCreateTool(context()).resolveExecution({ title: 't', prompt: 'p', cron: '0 9 * * *', in: '2h' }),
    );
    expect(result.isError).toBe(true);
  });
});

describe('JobList and JobDelete', () => {
  it('lists tasks and deletes one by id', async () => {
    const ctx = context();
    await run(new JobCreateTool(ctx).resolveExecution({ title: 'nightly', prompt: 'p', cron: '0 2 * * *' }));
    const id = new JobStore(ctx.screamHomeDir).list()[0]!.id;

    expect(text(await run(new JobListTool(ctx).resolveExecution()))).toContain(`id: ${id}`);
    expect(text(await run(new JobDeleteTool(ctx).resolveExecution({ id })))).toContain('Deleted');
    expect(new JobStore(ctx.screamHomeDir).list()).toEqual([]);
    expect((await run(new JobDeleteTool(ctx).resolveExecution({ id }))).isError).toBe(true);
    expect((await run(new JobDeleteTool(ctx).resolveExecution({ id: 'nope' }))).isError).toBe(true);
  });
});
