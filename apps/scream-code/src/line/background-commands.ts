/**
 * Chat commands for work that runs without the chat: `/jobs` (the background
 * tasks), `/brief` (a daily brief sent to this chat), `/project` (which project
 * this chat works in). Text is Chinese like every line-channel reply.
 */

import {
  decideInboxItem,
  JobError,
  JobStore,
  listInbox,
  readInboxItem,
  type InboxItem,
  type Job,
} from '@scream-code/scream-code-sdk';

/** The daily brief's prompt: a background task that reads the other tasks' runs. */
export const BRIEF_PROMPT = [
  'Write the person their daily brief and nothing else.',
  'Use JobList to see what each background task did since the last brief (about the last 24 hours): which runs succeeded, which failed and why, and which are switched off.',
  'The <waiting-for-the-person> block, when present, lists approvals and questions still waiting for them and those that expired unanswered; include them. Mention <skipped-runs> in one sentence.',
  'Reply in the language the person writes in, in a few short sentences: what got done, what failed, what is waiting for them.',
  'End with one line: the single thing they should look at, or that nothing needs them.',
].join(' ');
export const BRIEF_TITLE = '每日简报';
const BRIEF_CRON = '30 8 * * *';

function localTime(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function describe(job: Job): string {
  const schedule = job.starts.kind === 'once' ? `一次 ${localTime(job.starts.at)}` : job.starts.cron;
  const state = job.enabled
    ? job.nextRunAt === undefined
      ? '已结束'
      : `下次 ${localTime(job.nextRunAt)}`
    : job.disabledReason === 'fatigue'
      ? '连续失败已停用'
      : '已暂停';
  const last = job.runs.at(-1);
  const lastText =
    last === undefined
      ? '还没运行'
      : `上次${last.retrying === true ? '暂时失败，稍后重试' : last.ok ? '成功' : '失败'} ${localTime(last.at)}`;
  return `${job.id}  ${job.title}\n  ${schedule} · ${job.does === 'report' ? '只汇报' : '动手做'} · ${state} · ${lastText}`;
}

export function jobsText(screamHomeDir: string, hostRunning: boolean): string {
  const jobs = new JobStore(screamHomeDir).list();
  if (jobs.length === 0) return '还没有后台任务。直接告诉我要定期做什么，比如“每个工作日 9 点检查 CI，有问题再告诉我”。';
  const lines = ['后台任务：', ...jobs.map(describe)];
  if (!hostRunning) lines.push('', '注意：后台服务没在运行，任务现在不会执行。');
  lines.push('', '暂停/删除：/jobs pause <id>、/jobs resume <id>、/jobs rm <id>');
  return lines.join('\n');
}

export async function jobsCommand(screamHomeDir: string, arg: string, hostRunning: boolean): Promise<string> {
  const [sub = '', id = ''] = arg.trim().split(/\s+/);
  const store = new JobStore(screamHomeDir);
  try {
    if (sub === '' || sub === 'list') return jobsText(screamHomeDir, hostRunning);
    if (sub === 'rm' || sub === 'remove') return `已删除：${(await store.remove(id)).title}`;
    if (sub === 'pause') return `已暂停：${(await store.setEnabled(id, false)).title}`;
    if (sub === 'resume') return `已重新开启：${(await store.setEnabled(id, true)).title}`;
  } catch (error) {
    return error instanceof JobError ? error.message : `操作失败：${String(error)}`;
  }
  return '用法：/jobs [pause|resume|rm <id>]';
}

/** Whether `job` is a daily brief (made by `/brief` or the offer after `/service`). */
export function isBriefJob(job: Job): boolean {
  return job.title === BRIEF_TITLE || job.prompt.startsWith('Write the person their daily brief');
}

/**
 * Turn the daily brief on: every day at 08:30, sent to `deliverTo` (a chat)
 * when given, else kept in `/jobs` and `scream report`.
 */
export async function addBriefJob(
  screamHomeDir: string,
  input: { readonly workDir: string; readonly deliverTo?: string | undefined },
): Promise<Job> {
  return new JobStore(screamHomeDir).add({
    title: BRIEF_TITLE,
    prompt: BRIEF_PROMPT,
    starts: { kind: 'cron', cron: BRIEF_CRON },
    does: 'report',
    workDir: input.workDir,
    createdBy: 'person',
    ...(input.deliverTo === undefined ? {} : { deliverTo: input.deliverTo }),
  });
}

/** `/brief on|off`: a daily brief at 08:30, sent to this chat. */
export async function briefCommand(
  screamHomeDir: string,
  arg: string,
  input: { readonly sessionKey: string; readonly workDir: string },
): Promise<string> {
  const store = new JobStore(screamHomeDir);
  const existing = store.list().find((job) => isBriefJob(job) && job.deliverTo === input.sessionKey);
  const sub = arg.trim().toLowerCase();
  try {
    if (sub === 'off') {
      if (existing === undefined) return '这个聊天没有开每日简报。';
      await store.remove(existing.id);
      return '已关闭每日简报。';
    }
    if (sub === '' || sub === 'on') {
      if (existing !== undefined) {
        return `每日简报已经开着：每天 08:30 发到这里（${existing.id}）。关闭：/brief off`;
      }
      const job = await addBriefJob(screamHomeDir, { workDir: input.workDir, deliverTo: input.sessionKey });
      return `已开启每日简报：每天 08:30 把后台任务的结果汇总发到这里（${job.id}）。关闭：/brief off`;
    }
  } catch (error) {
    return error instanceof JobError ? error.message : `操作失败：${String(error)}`;
  }
  return '用法：/brief [on|off]';
}

/** `/project`: list recent project folders, or switch this chat to one (a fresh session). */
export async function projectCommand(
  arg: string,
  input: {
    readonly current: string;
    readonly recent: () => Promise<readonly string[]>;
    readonly isBusy: () => boolean;
    readonly switchTo: (workDir: string) => Promise<void>;
  },
): Promise<string> {
  const recent = await input.recent();
  const choice = arg.trim();
  if (choice === '') {
    const lines = [`当前项目：${input.current}`];
    if (recent.length > 0) {
      lines.push('', '最近的项目：', ...recent.map((dir, index) => `${String(index + 1)}. ${dir}`));
      lines.push('', '切换：/project <编号或绝对路径>（会开一个新会话）');
    }
    return lines.join('\n');
  }
  if (input.isBusy()) return '请等这一轮结束（回复 /stop 可中止）再切换项目。';
  const index = Number.parseInt(choice, 10);
  const target = /^\d+$/.test(choice) ? recent[index - 1] : choice;
  if (target === undefined) return `没有编号 ${choice} 的项目。发 /project 查看列表。`;
  await input.switchTo(target);
  return `已切换到：${target}\n接下来的消息会在这个项目里新开会话处理。`;
}

// ─── The "waiting for you" inbox ─────────────────────────────────────────

/** How an inbox item reads in a chat, with the commands that answer it. */
export function inboxNotice(item: InboxItem): string {
  if (item.kind === 'memory') {
    const lines = [`后台的工作想记住 ${String(item.memories?.length ?? 0)} 条经验（你同意前不会用到）：`];
    for (const memo of (item.memories ?? []).slice(0, 5)) lines.push(`· ${memo.userNeed}：${memo.whatWorked !== 'none' ? memo.whatWorked : memo.approach}`.slice(0, 200));
    lines.push('', `保存：/approve ${item.id}　不要：/reject ${item.id}（7 天内有效）`);
    return lines.join('\n');
  }
  if (item.kind === 'question') {
    const lines = ['后台的工作有个问题要问你：'];
    for (const q of item.question?.items ?? []) {
      lines.push(`· ${q.question}${q.options.length === 0 ? '' : `（${q.options.join(' / ')}）`}`);
    }
    lines.push('', `回答：/answer ${item.id} <你的回答>（24 小时内有效）`);
    return lines.join('\n');
  }
  return [
    '后台的工作想做一件需要你同意的事：',
    item.approval?.action ?? '',
    `（${item.approval?.reason ?? ''}）`,
    '',
    '直接回复：同意 / 拒绝 / 以后都同意',
    `（也可以：/approve ${item.id} session 本会话都同意，/mine ${item.id} 我自己做了）`,
    '24 小时内没回应就作废；它不会停下来等，先去做别的了。',
  ].join('\n');
}

export function inboxText(screamHomeDir: string): string {
  const pending = listInbox(screamHomeDir).filter((item) => item.status === 'pending');
  if (pending.length === 0) return '没有等你处理的事。';
  return pending.map(inboxNotice).join('\n\n────\n\n');
}

/** `/approve <id> [always]`, `/reject <id>`, `/mine <id>`, `/answer <id> <text>`. */
export function inboxDecisionCommand(
  screamHomeDir: string,
  command: '/approve' | '/reject' | '/mine' | '/answer',
  arg: string,
): string {
  const [id = '', ...rest] = arg.trim().split(/\s+/);
  if (id === '') return '用法：/approve <编号> [always]、/reject <编号>、/mine <编号>、/answer <编号> <回答>';
  const answerText = rest.join(' ').trim();
  const decision =
    command === '/answer'
      ? 'answer'
      : command === '/reject'
        ? 'reject'
        : command === '/mine'
          ? 'did-it'
          : rest[0]?.toLowerCase() === 'always'
            ? 'always'
            : rest[0]?.toLowerCase() === 'session'
              ? 'session'
              : 'approve';
  if (decision === 'answer' && answerText === '') return `请写上回答：/answer ${id} <你的回答>`;
  const memoryItem = readInboxItem(screamHomeDir, id)?.kind === 'memory';
  const item = decideInboxItem(
    screamHomeDir,
    id,
    memoryItem && decision === 'always' ? 'approve' : decision,
    decision === 'answer' ? answerText : undefined,
  );
  if (item === undefined) return `没有待处理的 ${id}（可能已经处理过、已作废，或者类型不对）。发 /inbox 看看还剩什么。`;
  if (item.kind === 'memory') return item.decision === 'approve' ? '好，这些经验会保存下来。' : '好，不保存。';
  switch (decision) {
    case 'approve':
      return '好，已同意这一次。后台会接着去做，做完把结果发给你。';
    case 'always':
      return '好，已同意，以后无人值守时同样的操作都直接做。后台会接着去做。';
    case 'session':
      return '好，这个会话里同样的操作都直接做。后台会接着去做。';
    case 'reject':
      return '好，不做这件事。后台会继续做别的。';
    case 'did-it':
      return '好，记下是你自己做的，后台会接着往下做。';
    case 'answer':
      return '收到，已把你的回答转给后台。';
  }
}

const QUICK_REPLIES: Readonly<Record<string, 'approve' | 'always' | 'reject'>> = {
  同意: 'approve',
  批准: 'approve',
  approve: 'approve',
  以后都同意: 'always',
  总是同意: 'always',
  always: 'always',
  拒绝: 'reject',
  不同意: 'reject',
  reject: 'reject',
};

/**
 * A plain "同意" / "拒绝" / "以后都同意" in a chat answers what was pushed to
 * that chat, so nobody has to type `/approve inbox-3f2a1c` on a phone. Only
 * these exact words count, and only while something pushed to this very chat
 * waits (an item pushed elsewhere is never answered from here);
 * otherwise (undefined) the message goes to the model as usual. With more
 * than one waiting, the reply lists them so the person can pick by id.
 */
export function quickInboxReply(screamHomeDir: string, sessionKey: string, text: string): string | undefined {
  const word = text.trim().replace(/[。！!.,，\s]+$/u, '').toLowerCase();
  const decision = QUICK_REPLIES[word];
  if (decision === undefined) return undefined;
  const waiting = listInbox(screamHomeDir).filter(
    (item) => item.status === 'pending' && item.notifiedTo === sessionKey && item.kind === 'approval',
  );
  if (waiting.length === 0) return undefined;
  if (waiting.length > 1) {
    return [
      `有 ${String(waiting.length)} 件等你处理，请说明是哪一件：`,
      ...waiting.map((item) => `· ${item.id}：${(item.approval?.action ?? '').slice(0, 80)}`),
      '',
      '回复 /approve <编号>（加 always：以后都同意）或 /reject <编号>',
    ].join('\n');
  }
  const item = waiting[0]!;
  return inboxDecisionCommand(screamHomeDir, decision === 'reject' ? '/reject' : '/approve', ` ${item.id}${decision === 'always' ? ' always' : ''}`);
}

