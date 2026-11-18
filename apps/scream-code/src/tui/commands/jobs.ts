/**
 * `/jobs` — everything that runs without being asked, in one place:
 * background tasks (run by the background host, each run in a fresh session)
 * and this session's reminders (fired into this conversation). `/cron` is the
 * same command.
 *
 *   /jobs              the panel
 *   /jobs add          new background task (schedule, what to do, act or report)
 *   /jobs remind       new reminder in this session
 *   /jobs rm <id>      delete a task (`job-…`) or a reminder (8 hex)
 *
 * A background task's runs are its history here, never in `/sessions`. When
 * the background host is not running, the panel says so: tasks only run while
 * it does (`/service` keeps it running).
 */

import { t } from '@scream-code/config';
import {
  decideInboxItem,
  JobError,
  JobStore,
  listInbox,
  patchInboxItem,
  saveInboxMemories,
  type InboxItem,
  type Job,
} from '@scream-code/scream-code-sdk';

import { readHostStatus, wakeHost } from '#/host/control';
import { pauseAllBackgroundWork } from '#/host/pause-all';
import { addSelfReviewJob, isSelfReviewJob, selfReviewPrompt } from '#/host/self-review';
import { loadLastChat } from '#/line/session-driver';
import { getDataDir } from '#/utils/paths';

import { ChoicePickerComponent, type ChoiceOption } from '../components/dialogs/choice-picker';
import { formatErrorMessage } from '../utils/event-payload';
import { handleCronCommand, pickFrom, pickSchedule, promptTextInput } from './cron';
import { handleGoalCommand } from './goal';
import type { SlashCommandHost } from './dispatch';

const NEW_JOB = '__jobs_new__';
const REMINDERS = '__jobs_reminders__';
const INBOX = '__jobs_inbox__';
const SELF_REVIEW = '__jobs_self_review__';
const GOAL = '__jobs_goal__';
const RUN_LINES = 6;

function store(): JobStore {
  return new JobStore(getDataDir());
}

function localTime(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function scheduleText(job: Job): string {
  return job.starts.kind === 'once' ? t('jobs.once_at', { time: localTime(job.starts.at) }) : job.starts.cron;
}

function stateText(job: Job): string {
  if (!job.enabled) {
    if (job.disabledReason === 'fatigue') return t('jobs.state_fatigue');
    if (job.disabledReason === 'done') return t('jobs.state_done');
    if (job.disabledReason === 'ended') return t('jobs.state_ended');
    return t('jobs.state_paused');
  }
  return job.nextRunAt === undefined ? t('jobs.state_ended') : t('jobs.next', { time: localTime(job.nextRunAt) });
}

function lastRunText(job: Job): string {
  const last = job.runs.at(-1);
  if (last === undefined) return t('jobs.never_ran');
  const ok = job.runs.filter((run) => run.ok).length;
  return t('jobs.last_run', {
    mark: last.ok ? '✓' : '✗',
    time: localTime(last.at),
    ok: String(ok),
    failed: String(job.runs.length - ok),
  });
}

function jobRow(job: Job): ChoiceOption {
  const does = job.does === 'report' ? t('jobs.does_report') : t('jobs.does_act');
  const until = job.until.kind === 'outcome' ? ` · ${t('jobs.until_outcome', { criterion: job.until.criterion })}` : '';
  return {
    value: job.id,
    label: `${job.title}  ${scheduleText(job)} · ${does}${until}`,
    description: `${stateText(job)} · ${lastRunText(job)}`,
  };
}

export async function handleJobsCommand(host: SlashCommandHost, args: string): Promise<void> {
  const [sub = '', ...rest] = args.trim().split(/\s+/);
  switch (sub.toLowerCase()) {
    case '':
    case 'list':
      await openJobsPanel(host);
      return;
    case 'add':
    case 'new':
      await newJobWizard(host);
      return;
    case 'stop':
    case 'pause-all': {
      const result = await pauseAllBackgroundWork();
      host.showStatus(t('jobs.paused_all', { count: String(result.paused) }));
      return;
    }
    case 'remind':
      // This session's reminders keep their own panel and wizard.
      await handleCronCommand(host, 'add');
      return;
    case 'rm':
    case 'remove':
    case 'delete': {
      const id = rest[0] ?? '';
      if (id.startsWith('job-')) {
        await deleteJob(host, id);
        return;
      }
      if (id === '') {
        host.showStatus(t('jobs.usage'), host.state.theme.colors.textDim);
        return;
      }
      await handleCronCommand(host, `rm ${id}`);
      return;
    }
    default:
      host.showStatus(t('jobs.usage'), host.state.theme.colors.textDim);
  }
}

async function openJobsPanel(host: SlashCommandHost): Promise<void> {
  const jobs = store().list();
  const hostStatus = await readHostStatus();
  let reminderCount = 0;
  try {
    reminderCount = (await host.session?.listCronTasks())?.length ?? 0;
  } catch {
    reminderCount = 0;
  }
  const details: string[] = [];
  if (jobs.some((job) => job.enabled) && !hostStatus.running) details.push(t('jobs.host_not_running'));
  const waiting = pendingInbox();
  // This session's goal, when it has one: the work that keeps going by itself.
  let goal: { objective: string; status: string } | undefined;
  try {
    const current = (await host.session?.getGoal())?.goal;
    if (current !== undefined && current !== null && current.status !== 'complete') goal = current;
  } catch {
    goal = undefined;
  }
  const options: ChoiceOption[] = [
    ...(goal === undefined
      ? []
      : [
          {
            value: GOAL,
            label: t('jobs.goal_row', {
              objective: goal.objective.split('\n')[0]!.slice(0, 60),
              status: t(`jobs.goal_${goal.status === 'active' ? 'active' : goal.status === 'paused' ? 'paused' : 'blocked'}`),
            }),
            description: t('jobs.goal_hint'),
          },
        ]),
    ...(waiting.length === 0
      ? []
      : [
          {
            value: INBOX,
            label: t('jobs.inbox_row', { count: String(waiting.length), first: inboxLine(waiting[0]!) }),
            description: t('jobs.inbox_row_hint'),
          },
        ]),
    ...jobs.map(jobRow),
    { value: NEW_JOB, label: t('jobs.new'), description: t('jobs.new_hint') },
    ...(jobs.some(isSelfReviewJob)
      ? []
      : [{ value: SELF_REVIEW, label: t('jobs.self_review_on'), description: t('jobs.self_review_hint') }]),
    ...(host.session === undefined
      ? []
      : [{ value: REMINDERS, label: t('jobs.reminders', { count: String(reminderCount) }), description: t('jobs.reminders_hint') }]),
  ];
  const choice = await new Promise<string | undefined>((resolve) => {
    host.mountEditorReplacement(
      new ChoicePickerComponent({
        title: t('jobs.title'),
        details,
        hint: t('jobs.hint'),
        options,
        colors: host.state.theme.colors,
        onSelect: (value: string) => {
          host.restoreEditor();
          resolve(value);
        },
        onCancel: () => {
          host.restoreEditor();
          resolve(undefined);
        },
        onDispose: () => {
          resolve(undefined);
        },
      }),
    );
  });
  if (choice === undefined) return;
  if (choice === NEW_JOB) {
    await newJobWizard(host);
    return;
  }
  if (choice === REMINDERS) {
    await handleCronCommand(host, '');
    return;
  }
  if (choice === GOAL) {
    await handleGoalCommand(host, '');
    return;
  }
  if (choice === SELF_REVIEW) {
    await enableSelfReview(host);
    await openJobsPanel(host);
    return;
  }
  if (choice === INBOX) {
    await openInbox(host);
    await openJobsPanel(host);
    return;
  }
  const job = store().get(choice);
  if (job !== undefined) await openJob(host, job);
}

/** One task: its recent runs, and pause / resume / delete. */
async function openJob(host: SlashCommandHost, job: Job): Promise<void> {
  const runs = job.runs
    .slice(-RUN_LINES)
    .toReversed()
    .map((run) => `${run.ok ? '✓' : '✗'} ${localTime(run.at)}  ${run.summary.split('\n')[0]?.slice(0, 100) ?? ''}`);
  const action = await new Promise<string | undefined>((resolve) => {
    host.mountEditorReplacement(
      new ChoicePickerComponent({
        title: job.title,
        details: [`${scheduleText(job)} · ${stateText(job)}`, ...(runs.length === 0 ? [t('jobs.never_ran')] : runs)],
        hint: t('jobs.job_hint'),
        options: [
          job.enabled ? { value: 'pause', label: t('jobs.pause') } : { value: 'resume', label: t('jobs.resume') },
          ...(isSelfReviewJob(job)
            ? [
                job.does === 'report'
                  ? { value: 'tier-act', label: t('jobs.self_review_act'), description: t('jobs.self_review_act_hint') }
                  : { value: 'tier-report', label: t('jobs.self_review_report') },
              ]
            : []),
          { value: 'delete', label: t('jobs.delete'), tone: 'danger' },
          { value: 'back', label: t('jobs.back') },
        ],
        colors: host.state.theme.colors,
        onSelect: (value: string) => {
          host.restoreEditor();
          resolve(value);
        },
        onCancel: () => {
          host.restoreEditor();
          resolve(undefined);
        },
        onDispose: () => {
          resolve(undefined);
        },
      }),
    );
  });
  if (action === 'pause' || action === 'resume') {
    try {
      const updated = await store().setEnabled(job.id, action === 'resume');
      host.showStatus(updated.enabled ? t('jobs.resumed', { title: job.title }) : t('jobs.paused', { title: job.title }));
    } catch (error) {
      host.showError(error instanceof JobError ? error.message : formatErrorMessage(error));
    }
  } else if (action === 'delete') {
    await deleteJob(host, job.id);
  } else if (action === 'tier-act' || action === 'tier-report') {
    const does = action === 'tier-act' ? 'act' : 'report';
    try {
      await store().setDoes(job.id, does, selfReviewPrompt(does));
      host.showStatus(does === 'act' ? t('jobs.self_review_now_act') : t('jobs.self_review_now_report'));
    } catch (error) {
      host.showError(error instanceof JobError ? error.message : formatErrorMessage(error));
    }
  }
  if (action !== undefined) await openJobsPanel(host);
}

function pendingInbox(): InboxItem[] {
  return listInbox(getDataDir()).filter((item) => item.status === 'pending' && item.expiresAt > Date.now());
}

function inboxLine(item: InboxItem): string {
  if (item.kind === 'memory') return t('jobs.inbox_memory_line', { count: String(item.memories?.length ?? 0) });
  const text = item.kind === 'question' ? (item.question?.items[0]?.question ?? '') : (item.approval?.action ?? '');
  const line = text.split('\n')[0] ?? '';
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
}

async function choose(host: SlashCommandHost, title: string, details: string[], options: ChoiceOption[]): Promise<string | undefined> {
  return new Promise<string | undefined>((resolve) => {
    host.mountEditorReplacement(
      new ChoicePickerComponent({
        title,
        details,
        options,
        colors: host.state.theme.colors,
        onSelect: (value: string) => {
          host.restoreEditor();
          resolve(value);
        },
        onCancel: () => {
          host.restoreEditor();
          resolve(undefined);
        },
        onDispose: () => {
          resolve(undefined);
        },
      }),
    );
  });
}

/** "Waiting for you": pick an item, then decide it. The host delivers the decision. */
async function openInbox(host: SlashCommandHost): Promise<void> {
  const items = pendingInbox();
  if (items.length === 0) return;
  const picked =
    items.length === 1
      ? items[0]!.id
      : await choose(
          host,
          t('jobs.inbox_title'),
          [],
          items.map((item) => ({ value: item.id, label: inboxLine(item), description: item.workDir })),
        );
  const item = items.find((candidate) => candidate.id === picked);
  if (item === undefined) return;
  const details = [
    ...(item.kind === 'memory'
      ? (item.memories ?? []).slice(0, 8).map((memo) => `· ${memo.userNeed}`.slice(0, 160))
      : []),
    ...(item.kind === 'memory'
      ? []
      : item.kind === 'question'
      ? (item.question?.items ?? []).map((q) => (q.options.length === 0 ? q.question : `${q.question}（${q.options.join(' / ')}）`))
      : [item.approval?.action ?? '', item.approval?.reason ?? '']),
    item.workDir,
    t('jobs.inbox_expires', { time: localTime(item.expiresAt) }),
  ];
  const options: ChoiceOption[] =
    item.kind === 'memory'
      ? [
          { value: 'approve', label: t('jobs.inbox_save') },
          { value: 'reject', label: t('jobs.inbox_drop'), tone: 'danger' },
          { value: 'back', label: t('jobs.back') },
        ]
      : item.kind === 'question'
      ? [
          ...(item.question?.items[0]?.options ?? []).map((label) => ({ value: `opt:${label}`, label })),
          { value: 'answer', label: t('jobs.inbox_answer') },
          { value: 'back', label: t('jobs.back') },
        ]
      : [
          { value: 'approve', label: t('jobs.inbox_approve') },
          { value: 'session', label: t('jobs.inbox_session') },
          { value: 'always', label: t('jobs.inbox_always') },
          { value: 'reject', label: t('jobs.inbox_reject'), tone: 'danger' },
          { value: 'did-it', label: t('jobs.inbox_mine') },
          { value: 'back', label: t('jobs.back') },
        ];
  const action = await choose(
    host,
    item.kind === 'question'
      ? t('jobs.inbox_question')
      : item.kind === 'memory'
        ? t('jobs.inbox_memory_title')
        : t('jobs.inbox_title'),
    details,
    options,
  );
  if (action === undefined || action === 'back') return;
  let decided: InboxItem | undefined;
  if (action === 'answer' || action.startsWith('opt:')) {
    const answer = action.startsWith('opt:')
      ? action.slice('opt:'.length)
      : (await promptTextInput(host, t('jobs.inbox_answer_title'), {}))?.trim();
    if (answer === undefined || answer === '') return;
    decided = decideInboxItem(getDataDir(), item.id, 'answer', answer);
  } else {
    decided = decideInboxItem(getDataDir(), item.id, action as 'approve' | 'session' | 'always' | 'reject' | 'did-it');
  }
  if (decided === undefined) {
    host.showStatus(t('jobs.inbox_gone'), host.state.theme.colors.textDim);
    return;
  }
  // Memories are saved (or dropped) right here: no background is needed for it.
  if (decided.kind === 'memory') {
    if (patchInboxItem(getDataDir(), decided.id, 'decided', { status: 'delivered' }) !== undefined && decided.decision === 'approve') {
      await saveInboxMemories(getDataDir(), decided).catch(() => 0);
    }
    host.showStatus(t('jobs.inbox_done'));
    return;
  }
  // The host delivers it on its next sweep; nudge it so that is now.
  await wakeHost().catch(() => false);
  host.showStatus(t('jobs.inbox_done'));
}

/** Turn the weekly self-review on (only proposes; results go to the last chat when there is one). */
export async function enableSelfReview(host: SlashCommandHost): Promise<void> {
  try {
    const chat = await loadLastChat().catch(() => undefined);
    await addSelfReviewJob(getDataDir(), { deliverTo: chat });
    host.showStatus(t('jobs.self_review_enabled'));
  } catch (error) {
    host.showError(error instanceof JobError ? error.message : formatErrorMessage(error));
  }
}

async function deleteJob(host: SlashCommandHost, id: string): Promise<void> {
  try {
    const removed = await store().remove(id);
    host.showStatus(t('jobs.deleted', { title: removed.title }));
  } catch (error) {
    host.showError(error instanceof JobError ? error.message : formatErrorMessage(error));
  }
}

/** New background task: what to do, when, and whether it acts or only reports. */
async function newJobWizard(host: SlashCommandHost): Promise<void> {
  const prompt = (
    await promptTextInput(host, t('jobs.wizard_task_title'), { placeholder: t('jobs.wizard_task_placeholder') })
  )?.trim();
  if (prompt === undefined || prompt === '') return;
  const cron = await pickSchedule(host);
  if (cron === undefined) return;
  const does = await pickFrom(host, t('jobs.wizard_does_title'), t('cron.wizard_schedule_hint'), [
    { value: 'act', label: t('jobs.does_act'), description: t('jobs.does_act_hint') },
    { value: 'report', label: t('jobs.does_report'), description: t('jobs.does_report_hint') },
  ]);
  if (does === undefined) return;
  try {
    const job = await store().add({
      title: prompt.split('\n')[0]!.slice(0, 40),
      prompt,
      starts: { kind: 'cron', cron },
      does: does === 'report' ? 'report' : 'act',
      workDir: host.state.appState.workDir,
      createdBy: 'person',
    });
    host.showStatus(t('jobs.created', { title: job.title, next: job.nextRunAt === undefined ? '—' : localTime(job.nextRunAt) }));
    if (!(await readHostStatus()).running) host.showStatus(t('jobs.host_not_running'), host.state.theme.colors.warning);
  } catch (error) {
    host.showError(error instanceof JobError ? error.message : formatErrorMessage(error));
  }
}
