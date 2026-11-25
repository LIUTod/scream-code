import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  formatReminder,
  parseTerminalReminder,
  reminderAllowed,
  ReminderOutbox,
  reminderTitle,
} from '#/host/reminders';

afterEach(() => {
  vi.useRealTimers();
});

describe('formatReminder', () => {
  it('names the session, its project and how long it took when it is done', () => {
    expect(
      formatReminder({ state: 'done', title: '修复标题丢失', workDir: '/Users/me/scream-code', elapsedMs: 12 * 60_000 }),
    ).toBe('✅「修复标题丢失」做完了 · scream-code · 用时 12 分钟');
  });

  it('says when the background finished work that had been cut off', () => {
    expect(formatReminder({ state: 'done', title: 't', recovered: true })).toBe('✅「t」做完了（中断后由后台接着做完）');
  });

  it('gives the reason a session stopped, on one line', () => {
    expect(formatReminder({ state: 'failed', title: '每日检查', what: 'Request timed out.\n[provider.timeout]' })).toBe(
      '❌「每日检查」没做完：Request timed out. [provider.timeout]',
    );
  });

  it('points a terminal session back to the terminal, and a background one to the reply', () => {
    expect(
      formatReminder({ state: 'waiting', title: '重构后台', waitingFor: 'question', answer: { kind: 'terminal' } }),
    ).toBe('⏸「重构后台」在等你回答一个问题 · 回到终端处理');
    expect(
      formatReminder({
        state: 'waiting',
        title: '发布',
        what: 'git push origin main',
        answer: { kind: 'chat', lines: ['回复「同意」或「拒绝」'] },
      }),
    ).toBe('⏸「发布」在等你批准：git push origin main\n回复「同意」或「拒绝」');
  });

  it('never carries more than a line of what went wrong', () => {
    const text = formatReminder({ state: 'failed', title: 't', what: 'x'.repeat(1000) });
    expect(Array.from(text).length).toBeLessThan(260);
  });
});

describe('reminderTitle', () => {
  it('cleans and shortens a title, and names an untitled or markup one by its project', () => {
    expect(reminderTitle('  a\u001B[31m\nb  ', undefined)).toBe('a b');
    expect(Array.from(reminderTitle('长'.repeat(60), undefined))).toHaveLength(41);
    expect(reminderTitle(undefined, '/w/scream-code')).toBe('未命名会话（scream-code）');
    expect(reminderTitle('<background-task id="x">', '/w/p')).toBe('未命名会话（p）');
    expect(reminderTitle('', undefined)).toBe('未命名会话');
  });
});

describe('reminderAllowed', () => {
  it('lets a chat choose: off, the background only, or also a terminal it is away from', () => {
    expect(reminderAllowed('off', 'background')).toBe(false);
    expect(reminderAllowed('background', 'background')).toBe(true);
    expect(reminderAllowed('background', 'terminal')).toBe(false);
    expect(reminderAllowed('away', 'terminal')).toBe(true);
  });
});

describe('ReminderOutbox', () => {
  it('sends what arrives together as one message, and each reminder once', async () => {
    vi.useFakeTimers();
    const send = vi.fn(async () => 'sent' as const);
    const outbox = new ReminderOutbox({ send, gatherMs: 1_000 });
    expect(outbox.push('chat-a', 'one', 'k1')).toBe(true);
    expect(outbox.push('chat-a', 'two', 'k2')).toBe(true);
    expect(outbox.push('chat-a', 'one again', 'k1')).toBe(false);
    outbox.push('chat-b', 'other');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledWith('chat-a', 'one\n\ntwo');
    expect(send).toHaveBeenCalledWith('chat-b', 'other');
  });

  it('reports a message that did not arrive, and sends the rest at shutdown', async () => {
    const onUndelivered = vi.fn();
    const outbox = new ReminderOutbox({ send: async () => 'no-target', onUndelivered, gatherMs: 60_000 });
    outbox.push('line-weixin-x', 'hello');
    await outbox.flushAll();
    expect(onUndelivered).toHaveBeenCalledWith('line-weixin-x', 'no-target');
  });
});

describe('parseTerminalReminder', () => {
  it('accepts what a terminal sends and answers it at the terminal', () => {
    expect(parseTerminalReminder({ state: 'waiting', title: 't', waitingFor: 'question' })).toEqual({
      state: 'waiting',
      title: 't',
      workDir: undefined,
      what: undefined,
      waitingFor: 'question',
      answer: { kind: 'terminal' },
    });
  });

  it('refuses anything else, including a health report from outside', () => {
    expect(parseTerminalReminder({ state: 'health', what: 'x' })).toBeUndefined();
    expect(parseTerminalReminder(null)).toBeUndefined();
    expect(parseTerminalReminder({ state: 'done', elapsedMs: -5 })).toEqual({
      state: 'done',
      title: undefined,
      workDir: undefined,
      what: undefined,
    });
  });
});
