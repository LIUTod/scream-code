import type { SlashCommandHost } from './dispatch';
import {
  LLM_NOT_SET_MESSAGE,
  NO_ACTIVE_SESSION_MESSAGE,
} from '../constant/scream-tui';
import {
  createLoopLimitRuntime,
  describeLoopLimit,
  describeLoopLimitRuntime,
  parseLoopLimitArgs,
  type LoopLimitRuntime,
} from '../utils/loop-limit';

/**
 * 切换循环模式。开启后，提示词会在每次 Agent 完成一轮后自动重发。
 *
 * 行为：
 * - /loop                （未开启）显示帮助
 * - /loop                （已开启）关闭循环模式
 * - /loop 10 [提示词]     开启循环，限制 10 次
 * - /loop 5m [提示词]     开启循环，限制 5 分钟
 * - /loop <提示词>        （已暂停）恢复循环并使用该提示词
 */
export async function handleLoopCommand(host: SlashCommandHost, args: string): Promise<void> {
  const trimmed = args.trim();

  // 已开启时：无参数 → 关闭；有参数 → 恢复/修改提示词。
  if (host.state.appState.loopModeEnabled) {
    if (!trimmed) {
      disableLoopMode(host, '循环模式已关闭。');
      return;
    }


    const parsed = parseLoopLimitArgs(args);
    if (typeof parsed === 'string') {
      host.showError(parsed);
      return;
    }

    const wasPaused = host.state.appState.loopPrompt === undefined;
    const loopLimit = parsed.limit
      ? createLoopLimitRuntime(parsed.limit)
      : host.state.appState.loopLimit;
    const loopPrompt = parsed.prompt ?? host.state.appState.loopPrompt;

    host.setAppState({ loopLimit, loopPrompt });

    if (wasPaused && loopPrompt !== undefined) {
      host.sendNormalUserInput(loopPrompt);
    } else {
      host.showStatus('循环提示词已更新。');
    }
    return;
  }

  // 未开启时：无参数 → 显示帮助；有参数 → 开启。
  if (!trimmed) {
    host.showNotice(
      '/loop 命令说明',
      '用法：/loop [次数|时长] [提示词]\n' +
        '· /loop 10 [提示词] — 限制 10 次迭代\n' +
        '· /loop 5m [提示词] — 限制 5 分钟\n' +
        '· /loop 1h30m [提示词] — 组合时长限制\n' +
        '按 Esc 暂停当前迭代；再次输入 /loop 关闭循环。',
    );
    return;
  }

  if (host.state.appState.model.trim().length === 0) {
    host.showError(LLM_NOT_SET_MESSAGE);
    return;
  }
  if (host.session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }

  const parsed = parseLoopLimitArgs(args);
  if (typeof parsed === 'string') {
    host.showError(parsed);
    return;
  }

  const loopLimit = createLoopLimitRuntime(parsed.limit);
  host.setAppState({
    loopModeEnabled: true,
    loopPrompt: undefined,
    loopLimit,
  });

  const limitSuffix = parsed.limit ? ` 限制：${describeLoopLimit(parsed.limit)}。` : '';
  const remainingSuffix = loopLimit ? ` ${describeLoopLimitRuntime(loopLimit)}。` : '';
  const promptBehavior = parsed.prompt
    ? '已固定提示词，每轮结束后自动重发。'
    : '下一条提示词将在每轮结束后自动重发。';

  host.showNotice(
    '循环模式已开启',
    `${promptBehavior}${limitSuffix}${remainingSuffix}\n\n` +
      '/loop 命令说明：\n' +
      '· /loop — 切换循环开关\n' +
      '· /loop 10 [提示词] — 限制 10 次迭代\n' +
      '· /loop 5m [提示词] — 限制 5 分钟\n' +
      '· /loop 1h30m [提示词] — 组合时长限制\n' +
      '按 Esc 暂停当前迭代；再次输入 /loop 关闭循环。',
  );

  // 如果命令行附带提示词，则作为第一轮直接提交。
  if (parsed.prompt) {
    host.sendNormalUserInput(parsed.prompt);
  }
}

export function disableLoopMode(host: SlashCommandHost, message?: string): void {
  host.setAppState({
    loopModeEnabled: false,
    loopPrompt: undefined,
    loopLimit: undefined,
  });
  if (message) {
    host.showStatus(message);
  }
}

export function describeLoopStatus(
  enabled: boolean,
  prompt: string | undefined,
  limit: LoopLimitRuntime | undefined,
): string {
  if (!enabled) return '循环：关闭';
  if (limit) return `循环：开启（${describeLoopLimitRuntime(limit)}）`;
  if (prompt) return '循环：开启（正在重复提示词）';
  return '循环：开启（等待下一条提示词）';
}
