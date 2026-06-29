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
import { detectGoalLoopConflict } from '../utils/goal-loop-conflict';

const DEFAULT_VERIFY_TIMEOUT_MS = 60_000;

function makeVerifier(command: string) {
  return { command, timeoutMs: DEFAULT_VERIFY_TIMEOUT_MS };
}

/**
 * 循环模式不能每轮等用户审批，开启时若处于 manual 权限，自动切到 auto。
 * 失败时不阻塞 loop 开启，仅静默跳过。
 */
async function ensureAutoPermission(host: SlashCommandHost): Promise<void> {
  if (host.state.appState.permissionMode !== 'manual') return;
  try {
    await host.requireSession().setPermission('auto');
    host.setAppState({ permissionMode: 'auto' });
    host.showStatus('权限已切到 auto（循环期间不再弹审批）。');
  } catch {
    // 切权限失败不阻塞 loop 开启，用户可手动 /config permission 切换。
  }
}

/**
 * 循环模式（无状态重试）。
 *
 * 定位：自动重试机 + 客观验证门。每轮重发同一条 prompt，AI 不记得上一轮
 * 的输出。适合配 `--verify` 验证命令，让客观 exit code 决定循环何时结束。
 *
 * 适合场景：任务与上次结果无关（等 CI、轮询健康检查、等服务起来、单次
 * 可能失败需要重试几次的幂等任务）。
 *
 * 不适合：任务需要根据上次失败调整策略 → 用 /goal（AI 带工作笔记迭代）。
 *
 * 行为：
 * - /loop                （未开启）显示帮助
 * - /loop                （已开启）关闭循环模式
 * - /loop 10 [提示词]     开启循环，限制 10 次
 * - /loop 5m [提示词]     开启循环，限制 5 分钟
 * - /loop <提示词>        （已暂停）恢复循环并使用该提示词
 * - /loop 10 ... --verify "命令"  每轮后跑验证命令，通过即停
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
    const loopVerifier = parsed.verifier
      ? makeVerifier(parsed.verifier.command)
      : host.state.appState.loopVerifier;

    host.setAppState({ loopLimit, loopPrompt, loopVerifier });

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
      '/loop 循环模式',
      '无状态重试：每轮重发同一条 prompt，AI 不记得上一轮输出。' +
        '配 --verify 验证命令，让客观 exit code 决定循环何时结束。\n\n' +
        '用法：/loop [次数|时长] [提示词] [--verify "验证命令"]\n' +
        '· /loop 10 [提示词] — 限制 10 次迭代\n' +
        '· /loop 5m [提示词] — 限制 5 分钟\n' +
        '· /loop 1h30m [提示词] — 组合时长限制\n' +
        '· /loop 10 修复 lint --verify "pnpm lint" — 每轮后跑验证，通过即停\n\n' +
        '适合：等 CI 通过、轮询健康检查、单次可能失败需重试的幂等任务。\n' +
        '不适合：需要根据上次失败调整策略 → 用 /goal（AI 带工作笔记迭代）。\n\n' +
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

  // Storm Breaker: /loop and /goal are semantically incompatible. loop resets
  // context each round, which would destroy goal's working notes.
  if (detectGoalLoopConflict(host.state.appState, 'enable_loop') === 'goal_active') {
    host.showNotice(
      'Storm Breaker（风暴守护者）',
      '当前已有激活的目标（/goal）。/loop 与 /goal 语义冲突：' +
        'loop 每轮重置上下文，会破坏 goal 的工作笔记迭代。' +
        '请先 /goal off 关闭目标，再开启循环模式。',
    );
    return;
  }

  const loopLimit = createLoopLimitRuntime(parsed.limit);
  host.setAppState({
    loopModeEnabled: true,
    loopPrompt: undefined,
    loopLimit,
    loopVerifier: parsed.verifier ? makeVerifier(parsed.verifier.command) : undefined,
    loopIteration: 0,
    loopLastVerifyPassed: undefined,
    loopVerifying: false,
  });

  await ensureAutoPermission(host);

  const limitSuffix = parsed.limit ? ` 限制：${describeLoopLimit(parsed.limit)}。` : '';
  const remainingSuffix = loopLimit ? ` ${describeLoopLimitRuntime(loopLimit)}。` : '';
  const verifierSuffix = parsed.verifier
    ? ` 验证命令：${parsed.verifier.command}（通过即停）。`
    : '';
  const promptBehavior = parsed.prompt
    ? '已固定提示词，每轮结束后自动重发。'
    : '下一条提示词将在每轮结束后自动重发。';

  host.showNotice(
    '循环模式已开启',
    `${promptBehavior}${limitSuffix}${remainingSuffix}${verifierSuffix}\n\n` +
      '提示：每轮重发同一条 prompt，AI 不记得上一轮输出。' +
      '需要根据上次失败调整策略时，用 /goal 更合适。\n\n' +
      '/loop 命令说明：\n' +
      '· /loop — 切换循环开关\n' +
      '· /loop 10 [提示词] — 限制 10 次迭代\n' +
      '· /loop 5m [提示词] — 限制 5 分钟\n' +
      '· /loop 1h30m [提示词] — 组合时长限制\n' +
      '· /loop 10 ... --verify "命令" — 每轮后跑验证，通过即停\n' +
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
    loopVerifier: undefined,
    loopIteration: 0,
    loopLastVerifyPassed: undefined,
    loopVerifying: false,
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
