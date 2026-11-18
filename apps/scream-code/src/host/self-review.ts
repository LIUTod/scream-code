/**
 * The weekly self-review: a built-in background job through which Scream
 * improves itself, and the one place it does.
 *
 * Every Monday at 08:00 it is given numbers only — tool friction over the
 * week, skill use over four weeks (see the SDK's `collectFriction`) — and
 * works in the person's skills folder. What it may do follows the job's own
 * tier, like any job:
 *
 * - "only reports" (the default): it changes nothing and proposes at most
 *   three improvements, each saying what, why, from which sessions (ids only)
 *   and which friction it should reduce;
 * - "acts": small changes (a new or edited skill) are made and recorded;
 *   anything larger — deleting a skill, a plugin, a memory — is refused by
 *   bot mode and lands in "waiting for you", so enabling plugin code or
 *   writing a memory always asks.
 *
 * Every change is recorded in the change history (`snapshotEvolution`, before
 * and after the run) and can be rolled back from `/skills`. Guardrails are out
 * of reach: the run's workspace is the skills folder, so permissions, budgets
 * and config are outside it, and skills grant no tools.
 */

import { mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { t } from '@scream-code/config';
import { collectFriction, JobStore, renderFrictionBlock, type Job, type JobDoes } from '@scream-code/scream-code-sdk';

const SELF_REVIEW_CRON = '0 8 * * 1';
const PROMPT_HEAD = 'This is your weekly self-review.';
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function selfReviewPrompt(does: JobDoes): string {
  return [
    PROMPT_HEAD,
    'Look only at the numbers in <tool-friction> and <skill-use>: they are aggregates. Do not open session files or read past conversations.',
    'Find at most three improvements: a new skill, a change to a skill, tidying memories, or a plugin. For each say what to change, why, which sessions it comes from (ids only), and which friction it should reduce.',
    'Your working directory is the person\'s skills folder; a skill is a folder with a SKILL.md.',
    does === 'act'
      ? 'Make small changes yourself (write or edit a skill); every change is recorded and can be rolled back. Do not delete skills. Anything larger, any memory and anything to do with plugins: ask with AskUserQuestion — it goes to the person — and carry on.'
      : 'Change nothing: only propose. The person decides.',
    'Never touch permissions, budgets, config.toml or anything outside the skills folder.',
    'Propose retiring a skill listed under "never invoked".',
    'Where an error rate is compared with the week before, say whether last week\'s changes helped.',
    'Reply in the language the person writes in. End with what you changed, what you propose, and the one thing the person should look at.',
  ].join(' ');
}

export function isSelfReviewJob(job: Job): boolean {
  return job.prompt.startsWith(PROMPT_HEAD);
}

export function selfReviewWorkDir(screamHomeDir: string): string {
  const dir = join(screamHomeDir, 'skills');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export async function addSelfReviewJob(
  screamHomeDir: string,
  input: { readonly does?: JobDoes; readonly deliverTo?: string | undefined } = {},
): Promise<Job> {
  const does = input.does ?? 'report';
  return new JobStore(screamHomeDir).add({
    title: t('jobs.self_review_title'),
    prompt: selfReviewPrompt(does),
    starts: { kind: 'cron', cron: SELF_REVIEW_CRON },
    does,
    workDir: selfReviewWorkDir(screamHomeDir),
    createdBy: 'person',
    ...(input.deliverTo === undefined ? {} : { deliverTo: input.deliverTo }),
  });
}

function userSkillNames(screamHomeDir: string): string[] {
  try {
    return readdirSync(join(screamHomeDir, 'skills'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** The numbers a self-review run is given. */
export async function selfReviewContext(screamHomeDir: string, now: number): Promise<string> {
  const [week, previous, month] = await Promise.all([
    collectFriction(screamHomeDir, now - WEEK_MS),
    collectFriction(screamHomeDir, now - 2 * WEEK_MS, now - WEEK_MS),
    collectFriction(screamHomeDir, now - 4 * WEEK_MS),
  ]);
  return renderFrictionBlock(week, month, userSkillNames(screamHomeDir), previous);
}
