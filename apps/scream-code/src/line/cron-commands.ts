/**
 * `/cron` on an IM channel — the phone-side counterpart of the TUI command.
 *
 * Tasks created here belong to the chat's own session, which is exactly what
 * the delivery relay expects: they fire inside that session and their result is
 * pushed back to the same chat. Keep the copy short and linear; a phone shows
 * one narrow column and no tables.
 */

import type { CronTaskInfo } from '@scream-code/scream-code-sdk';

const PROMPT_PREVIEW_CHARS = 60;

/** `add <min hour dom mon dow> <prompt…>` → the two fields the RPC wants. */
export function parseCronAdd(
  parts: readonly string[],
): { cron: string; prompt: string; silent?: boolean; mute?: boolean } | null {
  const rest = [...parts];
  let silent = false;
  let mute = false;
  while (rest[0] === '--silent' || rest[0] === '--mute') {
    if (rest.shift() === '--silent') silent = true;
    else mute = true;
  }
  if (rest.length < 6) return null;
  const cron = rest.slice(0, 5).join(' ');
  const prompt = rest.slice(5).join(' ').trim();
  if (prompt === '') return null;
  return {
    cron,
    prompt,
    ...(silent ? { silent: true } : {}),
    ...(mute ? { mute: true } : {}),
  };
}

function describeNext(task: CronTaskInfo, now: number): string {
  if (task.nextFireAt === null) return task.recurring ? '不再触发' : '已触发';
  const minutes = Math.max(0, Math.round((task.nextFireAt - now) / 60_000));
  if (minutes <= 1) return '即将触发';
  return `下次 ${minutes} 分钟后`;
}

function shorten(text: string): string {
  const chars = Array.from(text);
  return chars.length > PROMPT_PREVIEW_CHARS
    ? `${chars.slice(0, PROMPT_PREVIEW_CHARS - 1).join('')}…`
    : text;
}

/** Listing for `/cron` / `/cron list`; `now` is injectable for tests. */
export function formatCronList(tasks: readonly CronTaskInfo[], now: number = Date.now()): string {
  if (tasks.length === 0) {
    return '还没有定时任务。\n/cron add <分 时 日 月 周> <要做的事>';
  }
  const lines = [`定时任务（${tasks.length}）`];
  for (const task of tasks) {
    const flags = [
      describeNext(task, now),
      task.stale ? '已过期' : '',
      task.recurring ? '' : '一次性',
      task.silent === true ? '静默' : '',
      task.mute === true ? '静音' : '',
    ]
      .filter((part) => part !== '')
      .join(' · ');
    lines.push(`${task.id}  ${task.cron}  ${flags}`);
    lines.push(`  ${shorten(task.prompt)}`);
    if (task.lastError !== undefined && task.lastError !== null) {
      lines.push(`  上次失败：${shorten(task.lastError)}`);
    }
  }
  lines.push('回复 /cron rm <id> 删除。');
  return lines.join('\n');
}

export const CRON_USAGE =
  '用法：/cron list · /cron add [--silent|--mute] <分 时 日 月 周> <要做的事> · /cron rm <id>';
// `--silent` = no "fired" notice, result still delivered · `--mute` = nothing at all
