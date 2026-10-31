import { describe, expect, it, vi } from 'vitest';

import { formatCronList, parseCronAdd } from '#/line/cron-commands';
import { runLineCommand } from '#/line/command-router';
import type { Session } from '@scream-code/scream-code-sdk';

const NOW = 1_700_000_000_000;
const inMinutes = (n: number): number => NOW + n * 60_000;

function task(overrides: Partial<Parameters<typeof formatCronList>[0][number]> = {}) {
  return {
    id: 'job-1',
    cron: '*/5 * * * *',
    prompt: '检查 CI 构建状态',
    createdAt: NOW,
    recurring: true,
    stale: false,
    nextFireAt: inMinutes(5),
    ...overrides,
  };
}

function textOf(result: Awaited<ReturnType<typeof runLineCommand>>): string {
  if (!('text' in result)) throw new Error('expected text');
  return result.text;
}

function cronDeps(session: Partial<Session>) {
  return {
    getSession: vi.fn().mockResolvedValue(session as Session),
    resetSession: vi.fn().mockResolvedValue(undefined),
    isBusy: () => false,
    defaultModel: 'scream-k2-5',
  };
}

describe('parseCronAdd', () => {
  it('splits the five cron fields from the prompt', () => {
    expect(parseCronAdd(['*/5', '*', '*', '*', '*', '检查', 'CI'])).toEqual({
      cron: '*/5 * * * *',
      prompt: '检查 CI',
    });
  });

  it('accepts --silent / --mute ahead of the expression', () => {
    expect(parseCronAdd(['--silent', '*/5', '*', '*', '*', '*', '喝水'])).toEqual({
      cron: '*/5 * * * *',
      prompt: '喝水',
      silent: true,
    });
    expect(parseCronAdd(['--mute', '*/5', '*', '*', '*', '*', '清理'])).toEqual({
      cron: '*/5 * * * *',
      prompt: '清理',
      mute: true,
    });
  });

  it('rejects an incomplete expression or empty prompt', () => {
    expect(parseCronAdd(['*/5', '*', '*', '*'])).toBeNull();
    expect(parseCronAdd(['*/5', '*', '*', '*', '*'])).toBeNull();
  });
});

describe('formatCronList', () => {
  it('describes an empty list with the way to create one', () => {
    expect(formatCronList([], NOW)).toContain('/cron add');
  });

  it('shows id, expression, next fire and the prompt', () => {
    const text = formatCronList([task(), task({ id: 'job-2', recurring: false, stale: true })], NOW);
    expect(text).toContain('job-1');
    expect(text).toContain('*/5 * * * *');
    expect(text).toContain('下次 5 分钟后');
    expect(text).toContain('检查 CI 构建状态');
    expect(text).toContain('已过期');
    expect(text).toContain('一次性');
  });

  it('marks quiet tasks and shows the last failure', () => {
    const text = formatCronList(
      [task({ silent: true, mute: false, lastError: 'tool timeout' })],
      NOW,
    );
    expect(text).toContain('静默');
    expect(text).toContain('上次失败：tool timeout');
  });

  it('shortens a long prompt', () => {
    const text = formatCronList([task({ prompt: '甲'.repeat(120) })], NOW);
    expect(text).toContain('…');
    expect(text).not.toContain('甲'.repeat(120));
  });
});

describe('/cron command', () => {
  it('lists tasks through the session RPC', async () => {
    const listCronTasks = vi.fn().mockResolvedValue([task()]);
    const text = textOf(await runLineCommand('/cron', cronDeps({ listCronTasks })));
    expect(listCronTasks).toHaveBeenCalledTimes(1);
    expect(text).toContain('job-1');
  });

  it('creates a task, keeping the chat as its owner', async () => {
    const createCronTask = vi
      .fn()
      .mockImplementation(async (input: { cron: string; prompt: string }) =>
        task({ id: 'job-9', cron: input.cron, prompt: input.prompt }),
      );
    const text = textOf(
      await runLineCommand('/cron add */10 * * * * 提醒我喝水', cronDeps({ createCronTask })),
    );
    expect(createCronTask).toHaveBeenCalledWith({ cron: '*/10 * * * *', prompt: '提醒我喝水' });
    expect(text).toContain('*/10 * * * *');
  });

  it('passes the quiet flags through to the RPC', async () => {
    const createCronTask = vi.fn().mockResolvedValue(task({ id: 'job-q' }));
    await runLineCommand('/cron add --silent */10 * * * * 安静点', cronDeps({ createCronTask }));
    expect(createCronTask).toHaveBeenCalledWith({
      cron: '*/10 * * * *',
      prompt: '安静点',
      silent: true,
    });
  });

  it('removes tasks by id', async () => {
    const removeCronTasks = vi.fn().mockResolvedValue(['job-1']);
    const text = textOf(await runLineCommand('/cron rm job-1', cronDeps({ removeCronTasks })));
    expect(removeCronTasks).toHaveBeenCalledWith(['job-1']);
    expect(text).toContain('已删除 1 个任务');
  });

  it('explains the usage for an unknown subcommand', async () => {
    const text = textOf(await runLineCommand('/cron add', cronDeps({})));
    expect(text).toContain('/cron add');
  });

  it('reports RPC failures instead of throwing', async () => {
    const listCronTasks = vi.fn().mockRejectedValue(new Error('session closed'));
    const text = textOf(await runLineCommand('/cron list', cronDeps({ listCronTasks })));
    expect(text).toContain('定时任务操作失败');
  });
});
