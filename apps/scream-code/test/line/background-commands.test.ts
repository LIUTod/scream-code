import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { JobStore } from '@scream-code/scream-code-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BRIEF_TITLE, briefCommand, jobsCommand, projectCommand } from '#/line/background-commands';

const homes: string[] = [];
function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'line-bg-'));
  homes.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('/jobs in a chat', () => {
  it('lists tasks, warns when the host is down, and pauses one', async () => {
    const dir = home();
    const job = await new JobStore(dir).add({
      title: 'CI',
      prompt: 'check',
      starts: { kind: 'cron', cron: '0 9 * * *' },
      workDir: '/w',
      createdBy: 'person',
    });
    const listed = await jobsCommand(dir, '', false);
    expect(listed).toContain(job.id);
    expect(listed).toContain('后台服务没在运行');
    expect(await jobsCommand(dir, `pause ${job.id}`, true)).toBe('已暂停：CI');
    expect(new JobStore(dir).get(job.id)?.enabled).toBe(false);
  });
});

describe('/brief', () => {
  it('turns a daily brief to this chat on once, and off again', async () => {
    const dir = home();
    const input = { sessionKey: 'line-feishu-abc', workDir: '/w' };
    expect(await briefCommand(dir, 'on', input)).toContain('已开启每日简报');
    expect(await briefCommand(dir, '', input)).toContain('已经开着');
    const [job] = new JobStore(dir).list();
    expect(job).toMatchObject({ title: BRIEF_TITLE, deliverTo: 'line-feishu-abc', does: 'report' });
    expect(await briefCommand(dir, 'off', input)).toBe('已关闭每日简报。');
    expect(new JobStore(dir).list()).toEqual([]);
  });
});

describe('/project', () => {
  const recent = async () => ['/home/me/app', '/home/me/site'];

  it('lists the current and recent projects', async () => {
    const text = await projectCommand('', { current: '/home/me/app', recent, isBusy: () => false, switchTo: vi.fn() });
    expect(text).toContain('当前项目：/home/me/app');
    expect(text).toContain('2. /home/me/site');
  });

  it('switches by number, and refuses while a turn runs', async () => {
    const switchTo = vi.fn(async () => {});
    expect(await projectCommand('2', { current: '/x', recent, isBusy: () => true, switchTo })).toContain('请等这一轮结束');
    expect(switchTo).not.toHaveBeenCalled();
    expect(await projectCommand('2', { current: '/x', recent, isBusy: () => false, switchTo })).toContain('已切换到：/home/me/site');
    expect(switchTo).toHaveBeenCalledWith('/home/me/site');
    expect(await projectCommand('9', { current: '/x', recent, isBusy: () => false, switchTo })).toContain('没有编号 9');
  });
});
