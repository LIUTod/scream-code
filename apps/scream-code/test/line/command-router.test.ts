import { describe, expect, it, vi } from 'vitest';

import { expandPrompt, isLineCommand, runLineCommand } from '#/line/command-router';
import type { LineCommandResult } from '#/line/command-router';
import type { Session } from '@scream-code/scream-code-sdk';

/** Minimal Session stub: only the members the router touches. */
function fakeSession(overrides: Record<string, unknown> = {}): Session {
  return {
    getStatus: vi.fn().mockResolvedValue({
      model: 'scream-k2-5',
      permission: 'yolo',
      planMode: false,
      wolfpackMode: false,
      rlmEnabled: false,
      thinkingLevel: 'off',
      contextUsage: 0.288,
      contextTokens: 288_000,
      maxContextTokens: 1_000_000,
    }),
    setModel: vi.fn().mockResolvedValue(undefined),
    compact: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as Session;
}

/** Narrows to the text variant; throws if the router returned something else. */
function textOf(result: LineCommandResult): string {
  if (!('text' in result)) throw new Error('expected a text result');
  return result.text;
}

function deps(overrides: Partial<Parameters<typeof runLineCommand>[1]> = {}) {
  const session = fakeSession();
  return {
    session,
    deps: {
      getSession: vi.fn().mockResolvedValue(session),
      resetSession: vi.fn().mockResolvedValue(undefined),
      isBusy: () => false,
      defaultModel: 'scream-k2-5',
      ...overrides,
    },
  };
}

describe('isLineCommand', () => {
  it('only treats slash-prefixed text as a command', () => {
    expect(isLineCommand('/status')).toBe(true);
    expect(isLineCommand('  /status')).toBe(true);
    expect(isLineCommand('你好 /status')).toBe(false);
    expect(isLineCommand('')).toBe(false);
  });
});

describe('runLineCommand', () => {
  it('lets non-commands through to the agent', async () => {
    const { deps: d } = deps();
    expect(await runLineCommand('帮我看看这个报错', d)).toEqual({ handled: false });
    expect(d.getSession).not.toHaveBeenCalled();
  });

  it('answers /help without touching the session', async () => {
    const { deps: d } = deps();
    const result = await runLineCommand('/help', d);
    expect(textOf(result)).toContain('/status');
    expect(textOf(result)).toContain('/model');
    expect(textOf(result)).toContain('/compact');
    expect(textOf(result)).toContain('/new');
    expect(d.getSession).not.toHaveBeenCalled();
  });

  it('reports model, modes and context for /status', async () => {
    const { deps: d } = deps();
    const result = await runLineCommand('/status', d);
    expect(textOf(result)).toContain('scream-k2-5');
    expect(textOf(result)).toContain('yolo');
    expect(textOf(result)).toContain('28.8%');
    expect(textOf(result)).toContain('288.0k/1.0M');
  });

  it('is case-insensitive on the command name', async () => {
    const { deps: d } = deps();
    const result = await runLineCommand('/STATUS', d);
    expect(result.handled).toBe(true);
  });

  it('shows the current model for /model without arguments', async () => {
    const { deps: d } = deps();
    const result = await runLineCommand('/model', d);
    expect(textOf(result)).toContain('scream-k2-5');
    expect(textOf(result)).toContain('/model <模型名>');
  });

  it('switches the model for /model <name>', async () => {
    const { deps: d, session } = deps();
    const result = await runLineCommand('/model deepseek-v4', d);
    expect(session.setModel).toHaveBeenCalledWith('deepseek-v4');
    expect(textOf(result)).toContain('deepseek-v4');
  });

  it('refuses mutating commands while a turn is running', async () => {
    const busy = deps({ isBusy: () => true });
    for (const command of ['/model foo', '/compact', '/new']) {
      const result = await runLineCommand(command, busy.deps);
      if (!result.handled) throw new Error(`expected handled: ${command}`);
      expect(textOf(result)).toContain('正在处理中');
    }
    expect(busy.session.setModel).not.toHaveBeenCalled();
    expect(busy.session.compact).not.toHaveBeenCalled();
    expect(busy.deps.resetSession).not.toHaveBeenCalled();
  });

  it('compacts and resets when idle', async () => {
    const { deps: d, session } = deps();
    expect(await runLineCommand('/compact', d)).toEqual({ handled: true, text: '已压缩上下文。' });
    expect(session.compact).toHaveBeenCalledTimes(1);

    expect(await runLineCommand('/new', d)).toEqual({
      handled: true,
      text: '已开启新会话，可以继续发消息了。',
    });
    expect(d.resetSession).toHaveBeenCalledTimes(1);
  });

  it('points desktop-only commands at the desktop client', async () => {
    const { deps: d } = deps();
    const result = await runLineCommand('/theme', d);
    expect(textOf(result)).toContain('桌面端');
  });

  it('falls through for an unknown command (reference behaviour)', async () => {
    const { deps: d } = deps();
    expect(await runLineCommand('/deploy-now', d)).toEqual({ handled: false });
  });

  it('reports failures as text instead of throwing', async () => {
    const failing = fakeSession({
      compact: vi.fn().mockRejectedValue(new Error('disk full')),
      setModel: vi.fn().mockRejectedValue(new Error('unknown model')),
    });
    const d = {
      getSession: vi.fn().mockResolvedValue(failing),
      resetSession: vi.fn().mockRejectedValue(new Error('boom')),
      isBusy: () => false,
      defaultModel: 'x',
    };
    const compact = await runLineCommand('/compact', d);
    expect(textOf(compact)).toContain('disk full');

    const model = await runLineCommand('/model nope', d);
    expect(textOf(model)).toContain('unknown model');

    const reset = await runLineCommand('/new', d);
    expect(textOf(reset)).toContain('boom');
  });
});

describe('custom commands', () => {
  const commands = [
    { name: '/standup', prompt: '总结昨天的提交：{args}' },
    { name: '/deploy', exec: './deploy.sh' },
    { name: '/notes', exec: 'ls notes' },
  ];

  it('expands a prompt-type command into a turn', async () => {
    const runExec = vi.fn();
    const result = await runLineCommand('/standup 支付模块', {
      ...deps().deps,
      commands,
      runExec,
    });
    expect(result).toEqual({ handled: true, prompt: '总结昨天的提交：支付模块' });
    expect(runExec).not.toHaveBeenCalled();
  });

  it('runs an exec-type command and returns its output', async () => {
    const runExec = vi.fn(async () => 'deployed');
    const result = await runLineCommand('/deploy prod', {
      ...deps().deps,
      commands,
      runExec,
    });
    expect(textOf(result)).toBe('deployed');
    expect(runExec).toHaveBeenCalledWith(expect.objectContaining({ name: '/deploy' }), 'prod');
  });

  it('refuses exec commands while a turn is running', async () => {
    const runExec = vi.fn(async () => 'nope');
    const result = await runLineCommand('/notes', {
      ...deps({ isBusy: () => true }).deps,
      commands,
      runExec,
    });
    expect(textOf(result)).toContain('正在处理中');
    expect(runExec).not.toHaveBeenCalled();
  });

  it('reports exec failures as text', async () => {
    const result = await runLineCommand('/notes', {
      ...deps().deps,
      commands,
      runExec: async () => {
        throw new Error('boom');
      },
    });
    expect(textOf(result)).toContain('boom');
  });

  it('keeps built-in commands ahead of a custom command with the same name', async () => {
    const result = await runLineCommand('/status', {
      ...deps().deps,
      commands: [{ name: '/status', prompt: 'should not win' }],
    });
    expect(textOf(result)).toContain('scream-k2-5');
  });

  it('lists custom commands in /help', async () => {
    const result = await runLineCommand('/help', {
      ...deps().deps,
      commands: [
        { name: '/standup', description: '总结昨天的提交', prompt: 'x' },
        { name: '/deploy', exec: './deploy.sh' },
      ],
    });
    const text = textOf(result);
    expect(text).toContain('/standup');
    expect(text).toContain('总结昨天的提交');
    expect(text).toContain('/deploy');
    expect(text).toContain('自定义脚本');
  });

  it('does not interpret `$` patterns in the substituted argument', async () => {
    const result = await runLineCommand('/standup $& $` $\'', {
      ...deps().deps,
      commands: [{ name: '/standup', prompt: '总结：{args}' }],
    });
    expect(result).toEqual({ handled: true, prompt: "总结：$& $` $'" });
  });

  it('still falls through for unknown commands when none match', async () => {
    const result = await runLineCommand('/nope', { ...deps().deps, commands });
    expect(result).toEqual({ handled: false });
  });
});

describe('expandPrompt', () => {
  it('substitutes a placeholder', () => {
    expect(expandPrompt('解释 {args} 的实现', 'daemon.ts')).toBe('解释 daemon.ts 的实现');
  });

  it('appends arguments when the template has no placeholder', () => {
    expect(expandPrompt('生成周报', '本周')).toBe('生成周报\n\n本周');
    expect(expandPrompt('生成周报', '')).toBe('生成周报');
  });
});
