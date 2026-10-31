/**
 * Slash-command gate for the IM channels.
 *
 * Ported behaviour from the reference implementation (`core/engine.go`): a
 * text message that starts with `/` is answered here and never reaches the
 * model; an unrecognised command falls through to the agent, so a prompt that
 * merely begins with a slash still works. A message carrying attachments is
 * never intercepted (the caller decides that — see `LineSessionDriver.submit`).
 *
 * Only commands that make sense without the TUI's widgets are supported here;
 * anything that needs a picker or wizard is refused with a pointer to the
 * desktop client.
 */

import type { Session } from '@scream-code/scream-code-sdk';

import { CRON_USAGE, formatCronList, parseCronAdd } from './cron-commands';

import type { LineCustomCommand } from './config';

export interface LineCommandDeps {
  /** Resolves (or creates) the chat's session. */
  getSession(): Promise<Session>;
  /** Closes and forgets the chat's session so the next message starts fresh. */
  resetSession(): Promise<void>;
  /** A turn is queued or running for this chat. */
  isBusy(): boolean;
  /**
   * Aborts the turn running for this chat right now. Returns false when there
   * was nothing to stop. Wired to `session.cancel()`, so `/stop` is the IM
   * counterpart of the TUI's interrupt — it must work *while* busy.
   */
  stopTurn?: () => boolean;
  /** Stops the running turn *and* starts a fresh session (`/cancel`). */
  cancelSession?: () => Promise<boolean>;
  /**
   * Startup ffmpeg probe result, rendered in `/status`. Voice is the only path
   * that depends on host tooling, so the user should learn about a missing AMR
   * encoder before sending rather than after.
   */
  voiceStatus?: string | null;
  /** Model configured as the default for new sessions. */
  defaultModel: string;
  /** User-defined commands from the line config. */
  commands?: readonly LineCustomCommand[];
  /** Runs an `exec`-type custom command and returns its reply text. */
  runExec?: (command: LineCustomCommand, arg: string) => Promise<string>;
}

export type LineCommandResult =
  | { handled: false }
  | { handled: true; text: string }
  /** A prompt-type custom command: run its expanded text as a user turn. */
  | { handled: true; prompt: string };

const HELP_TEXT = [
  '可用命令：',
  '/status            查看当前模型、权限与上下文占用',
  '/model <名称>      切换模型（不带参数查看当前值）',
  '/compact           压缩上下文',
  '/stop              停止正在运行的任务',
  '/cron              查看定时任务（add/rm 见用法）',
  '/cancel            停止并开始新会话',
  '/new               开启新会话',
  '/help              显示本帮助',
  '',
  '以下命令需要桌面端：/line 配置向导、/theme、/model（选择器）、/sessions',
  '未识别的命令会照常发给模型处理。',
].join('\n');

const DESKTOP_ONLY = new Set(['/line', '/theme', '/sessions', '/login', '/image']);

const BUSY_TEXT = '当前有任务正在处理中：回复 /stop 可中止，或等这一轮结束后再发该命令。';

/** Built-ins plus the user's configured commands. */
function helpText(commands: readonly LineCustomCommand[]): string {
  if (commands.length === 0) return HELP_TEXT;
  const custom = commands.map((command) => {
    const description = command.description ?? (command.exec !== undefined ? '自定义脚本' : '自定义提示词');
    return `${command.name.padEnd(18)}${description}`;
  });
  return [HELP_TEXT, '', '自定义命令：', ...custom].join('\n');
}

/** Cheap prefix test used by the driver before queueing anything. */
export function isLineCommand(rawText: string): boolean {
  return rawText.trimStart().startsWith('/');
}

/** Formats a token count the way the footer does (k/M, one decimal). */
function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

/**
 * Parses and executes one command. Never throws: failures are reported as the
 * reply text, because the IM side has no other channel for errors.
 */
export async function runLineCommand(
  rawText: string,
  deps: LineCommandDeps,
): Promise<LineCommandResult> {
  const text = rawText.trim();
  if (!text.startsWith('/')) return { handled: false };

  const [rawName, ...rest] = text.split(/\s+/);
  const name = (rawName ?? '').toLowerCase();
  const arg = rest.join(' ').trim();

  if (DESKTOP_ONLY.has(name)) {
    return { handled: true, text: `${name} 需要桌面端操作，IM 通道暂不支持。` };
  }

  switch (name) {
    case '/help':
      return { handled: true, text: helpText(deps.commands ?? []) };

    case '/status':
      return { handled: true, text: await statusText(deps) };

    case '/model':
      return { handled: true, text: await modelText(deps, arg) };

    case '/stop': {
      // Deliberately not busy-gated: stopping is only meaningful while busy.
      const stopped = deps.stopTurn?.() ?? false;
      if (!stopped) return { handled: true, text: '当前没有正在运行的任务。' };
      return { handled: true, text: '已停止当前任务。' };
    }

    case '/cron': {
      let session: Awaited<ReturnType<LineCommandDeps['getSession']>>;
      try {
        session = await deps.getSession();
      } catch (error) {
        return { handled: true, text: `读取会话失败：${describeError(error)}` };
      }
      const tokens = arg.trim() === '' ? [] : arg.trim().split(/\s+/);
      const sub = tokens[0];
      const parts = tokens.slice(1);
      try {
        if (sub === undefined || sub === 'list') {
          return { handled: true, text: formatCronList(await session.listCronTasks()) };
        }
        if (sub === 'add') {
          const parsed = parseCronAdd(parts);
          if (parsed === null) return { handled: true, text: CRON_USAGE };
          const task = await session.createCronTask(parsed);
          return { handled: true, text: `已创建定时任务 ${task.cron}：\n${task.prompt}` };
        }
        if (sub === 'rm' || sub === 'remove') {
          if (parts.length === 0) return { handled: true, text: CRON_USAGE };
          const removed = await session.removeCronTasks(parts);
          return {
            handled: true,
            text: removed.length === 0 ? '没有找到该任务。' : `已删除 ${removed.length} 个任务。`,
          };
        }
        return { handled: true, text: CRON_USAGE };
      } catch (error) {
        return { handled: true, text: `定时任务操作失败：${describeError(error)}` };
      }
    }

    case '/cancel': {
      const stopped = (await deps.cancelSession?.()) ?? false;
      return {
        handled: true,
        text: stopped ? '已停止当前任务并开始新会话。' : '已开始新会话。',
      };
    }

    case '/compact': {
      if (deps.isBusy()) return { handled: true, text: BUSY_TEXT };
      try {
        const session = await deps.getSession();
        await session.compact();
        return { handled: true, text: '已压缩上下文。' };
      } catch (error) {
        return { handled: true, text: `压缩失败：${describeError(error)}` };
      }
    }

    case '/new': {
      if (deps.isBusy()) return { handled: true, text: BUSY_TEXT };
      try {
        await deps.resetSession();
        return { handled: true, text: '已开启新会话，可以继续发消息了。' };
      } catch (error) {
        return { handled: true, text: `重置失败：${describeError(error)}` };
      }
    }

    default: {
      const custom = (deps.commands ?? []).find((item) => item.name.toLowerCase() === name);
      if (custom === undefined) {
        // Unknown command: hand it to the agent, exactly like the reference gate.
        return { handled: false };
      }
      if (custom.prompt !== undefined) {
        return { handled: true, prompt: expandPrompt(custom.prompt, arg) };
      }
      if (deps.runExec === undefined) {
        return { handled: true, text: `命令 ${name} 需要桌面端执行。` };
      }
      if (deps.isBusy()) return { handled: true, text: BUSY_TEXT };
      try {
        return { handled: true, text: await deps.runExec(custom, arg) };
      } catch (error) {
        return { handled: true, text: `命令执行失败：${describeError(error)}` };
      }
    }
  }
}

async function statusText(deps: LineCommandDeps): Promise<string> {
  try {
    const session = await deps.getSession();
    const status = await session.getStatus();
    const usage = Math.max(0, Math.min(1, status.contextUsage ?? 0));
    const percent = `${(usage * 100).toFixed(1)}%`;
    const modes: string[] = [status.permission];
    if (status.planMode) modes.push('计划模式');
    if (status.wolfpackMode) modes.push('群狼');
    if (status.rlmEnabled) modes.push('RLM');
    return [
      `模型：${status.model ?? (deps.defaultModel || '未知')}`,
      `模式：${modes.join(' · ')}`,
      `上下文：${percent}（${formatTokens(status.contextTokens)}/${formatTokens(status.maxContextTokens)}）`,
      `思考级别：${status.thinkingLevel}`,
      ...(deps.voiceStatus === undefined || deps.voiceStatus === null ? [] : [deps.voiceStatus]),
    ].join('\n');
  } catch (error) {
    return `读取状态失败：${describeError(error)}`;
  }
}

async function modelText(deps: LineCommandDeps, arg: string): Promise<string> {
  if (arg.length === 0) {
    try {
      const session = await deps.getSession();
      const status = await session.getStatus();
      const current = status.model ?? deps.defaultModel;
      return `当前模型：${current}\n切换请发：/model <模型名>（可选列表在桌面端 /model 查看）`;
    } catch (error) {
      return `读取模型失败：${describeError(error)}`;
    }
  }
  if (deps.isBusy()) return BUSY_TEXT;
  try {
    const session = await deps.getSession();
    await session.setModel(arg);
    return `已切换到模型：${arg}`;
  } catch (error) {
    return `切换失败：${describeError(error)}`;
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  return String(error);
}

/**
 * Substitutes `{args}` in a prompt-type command; without a placeholder the
 * arguments are appended, so both styles work.
 */
export function expandPrompt(template: string, arg: string): string {
  // Function replacement keeps `$&`, `$'` … in the user's argument literal.
  if (template.includes('{args}')) return template.replaceAll('{args}', () => arg);
  return arg.length > 0 ? `${template}\n\n${arg}` : template;
}
