import type { SlashCommandHost } from './dispatch';
import {
  getLlmNotSetMessage,
  getNoActiveSessionMessage,
} from '../constant/scream-tui';
import {
  createLoopLimitRuntime,
  describeLoopLimit,
  describeLoopLimitRuntime,
  parseLoopLimitArgs,
  type LoopLimitRuntime,
} from '../utils/loop-limit';
import { detectGoalLoopConflict } from '../utils/goal-loop-conflict';
import { t } from '@scream-code/config';

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
    host.showStatus(t('loop.permission_auto'));
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
      disableLoopMode(host, t('loop.disabled'));
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
      host.showStatus(t('loop.prompt_updated'));
    }
    return;
  }

  // 未开启时：无参数 → 显示帮助；有参数 → 开启。
  if (!trimmed) {
    host.showNotice(
      t('loop.title'),
      t('loop.help_desc') + '\n\n' +
        t('loop.help_usage') + '\n' +
        t('loop.help_example_count') + '\n' +
        t('loop.help_example_duration') + '\n' +
        t('loop.help_example_combo') + '\n' +
        t('loop.help_example_verify') + '\n\n' +
        t('loop.help_suitable') + '\n' +
        t('loop.help_unsuitable') + '\n\n' +
        t('loop.help_esc_hint'),
    );
    return;
  }

  if (host.state.appState.model.trim().length === 0) {
    host.showError(getLlmNotSetMessage());
    return;
  }
  if (host.session === undefined) {
    host.showError(getNoActiveSessionMessage());
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
      t('loop.conflict_goal_title'),
      t('loop.conflict_goal'),
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

  const limitSuffix = parsed.limit ? ` ${t('loop.limit_label')}${describeLoopLimit(parsed.limit)}。` : '';
  const remainingSuffix = loopLimit ? ` ${describeLoopLimitRuntime(loopLimit)}。` : '';
  const verifierSuffix = parsed.verifier
    ? ` ${t('loop.verify_label')}${parsed.verifier.command}${t('loop.verify_hint')}`
    : '';
  const promptBehavior = parsed.prompt
    ? t('loop.fixed_prompt')
    : t('loop.next_prompt');

  host.showNotice(
    t('loop.enabled'),
    `${promptBehavior}${limitSuffix}${remainingSuffix}${verifierSuffix}\n\n` +
      t('loop.hint_reset') +
      t('loop.hint_goal') + '\n\n' +
      t('loop.command_ref') + '\n' +
      t('loop.help_toggle') + '\n' +
      t('loop.help_example_count') + '\n' +
      t('loop.help_example_duration') + '\n' +
      t('loop.help_example_combo') + '\n' +
      t('loop.help_verify_short') + '\n' +
      t('loop.help_esc_hint'),
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
  if (!enabled) return t('loop.status_off');
  if (limit) return t('loop.status_on', { limit: describeLoopLimitRuntime(limit) });
  if (prompt) return t('loop.status_repeating');
  return t('loop.status_waiting');
}
