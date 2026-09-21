import { isSlashSkillName, slashHelpText } from '../commands';
import { useToast } from './useToast';
import { getActiveWebClient } from './webClient/activeClient';
import type { UseScreamWebClientReturn } from './webClient/types';

/**
 * Shared slash-command dispatch for the shell (home view) and the
 * conversation view. Both surfaces used to carry a copy-pasted switch that
 * had silently diverged; this composable is the single implementation.
 *
 * Divergences resolved in favour of the richer behaviour:
 * - `model` opens the model picker when one is reachable and only falls back
 *   to a plain status message when it is not (previously the shell showed the
 *   message unconditionally).
 * - `status` / `usage` open the info panel when the host provides one
 *   (previously the shell only printed a hint pointing at the chat page).
 * - Session-scoped commands (`compact`/`auto`/`ask`/`yes`/`bot`/`plan`/`fork`/
 *   `title`/`btw`) create a session first when none is active (previously
 *   the chat view assumed one existed).
 * - Unknown commands now go through toast; names matching an injected skill go through the skill activation channel.
 */

/** Commands forwarded verbatim to the active WS session.
 *  L3 cross-check against the server handleCommand (web/server.ts): compact/auto/ask/yes/bot/
 *  plan/fork/title/btw are all implemented; `bot` was previously missing from the frontend
 *  list, so dispatch fell into the unknown-command branch (a dead command) — it has now been
 *  added to the forwarding list. */
const SESSION_COMMANDS = ['compact', 'auto', 'ask', 'yes', 'bot', 'plan', 'fork', 'title', 'btw'] as const;

type ToggleValue = boolean | 'toggle';

/** Parse the shared TUI convention used by /wolfpack and /rlm. */
function parseToggle(args?: string): ToggleValue | null {
  const value = args?.trim().toLowerCase() ?? '';
  if (value.length === 0) return 'toggle';
  if (value === 'on') return true;
  if (value === 'off') return false;
  return null;
}

/** /revoke accepts a positive, safe integer turn count (blank = one). */
function parseRevokeCount(args?: string): number | null {
  const value = args?.trim() ?? '';
  if (value.length === 0) return 1;
  if (!/^[1-9]\d*$/.test(value)) return null;
  const count = Number(value);
  return Number.isSafeInteger(count) ? count : null;
}

/** /rlm-max-depth accepts zero (unlimited) or a non-negative integer. */
function parseRlmMaxDepth(args?: string): number | null {
  const value = args?.trim() ?? '';
  if (value.length === 0) return null;
  const depth = Number(value);
  return Number.isInteger(depth) && depth >= 0 && Number.isSafeInteger(depth) ? depth : null;
}

export interface SlashCommandHandlers {
  sendCommand: (name: string, args?: string) => void;
  clearMessages: () => void;
  appendSystemMessage: (text: string) => void;
  /** Create/await a session when none is active so a session command can be sent. Returning false cancels dispatch when transport setup failed. */
  ensureSession?: () => void | boolean | Promise<void | boolean>;
  /** `new` — context-specific fresh start (shell: back to home to create a session lazily; chat: back to home). */
  onNew: () => void;
  /** `model` — open the picker; return false (or omit) to fall back to a status message. */
  openModelPicker?: () => boolean;
  /** `status` / `usage` — open the richer info view; omit to keep the plain hint message. */
  showInfo?: (mode: 'status' | 'usage') => void;
  /** Current model name, read lazily for the picker's fallback message. */
  currentModel?: () => string | null | undefined;
  /**
   * Activation hook when `/skill-name args` matches an injected skill (returns success).
   * When omitted, it goes through the active webClient's activateSkill REST channel —
   * WebShell cannot be changed in this round, so the default path guarantees that picking
   * a skill from the menu and pressing Enter just works.
   */
  onSkill?: (name: string, args?: string) => Promise<boolean> | boolean;
}

export function useSlashCommands(handlers: SlashCommandHandlers) {
  const { showToast } = useToast();

  /**
   * Resolve the active client for commands that have a REST equivalent.  The
   * home view may not have a session yet, so create one first just like the
   * WS-forwarded commands do.  Keeping this lookup here also means the chat
   * and home composers share exactly the same command behaviour.
   */
  async function ensureSessionClient(): Promise<UseScreamWebClientReturn | null> {
    try {
      const ready = await handlers.ensureSession?.();
      if (ready === false) return null;
    } catch (error) {
      showToast(`无法创建会话：${error instanceof Error ? error.message : String(error)}`, 'error');
      return null;
    }
    const client = getActiveWebClient();
    if (!client || !client.sessionId.value) {
      showToast('请先创建或打开一个会话。', 'warning');
      return null;
    }
    return client;
  }

  async function runControlAction(
    action: () => Promise<boolean>,
    successMessage: string,
  ): Promise<void> {
    try {
      const ok = await action();
      // The REST client already surfaces the server's detailed error toast;
      // only add feedback for a successful mutation here.
      if (ok) showToast(successMessage, 'success');
    } catch (error) {
      showToast(`操作失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  async function dispatchWolfpack(args?: string): Promise<void> {
    const parsed = parseToggle(args);
    if (parsed === null) {
      showToast('用法：/wolfpack [on|off]', 'warning');
      return;
    }
    const client = await ensureSessionClient();
    if (!client) return;
    const enabled = parsed === 'toggle' ? client.status.value.wolfpackMode !== true : parsed;
    await runControlAction(
      () => client.switchWolfpack(enabled),
      `Wolfpack 模式已${enabled ? '开启' : '关闭'}`,
    );
  }

  async function dispatchRlm(args?: string): Promise<void> {
    const parsed = parseToggle(args);
    if (parsed === null) {
      showToast('用法：/rlm [on|off]', 'warning');
      return;
    }
    const client = await ensureSessionClient();
    if (!client) return;
    const enabled = parsed === 'toggle' ? client.status.value.rlmEnabled !== true : parsed;
    await runControlAction(
      () => client.switchRlm(enabled),
      `RLM 模式已${enabled ? '开启' : '关闭'}`,
    );
  }

  async function dispatchRlmMaxDepth(args?: string): Promise<void> {
    const value = args?.trim() ?? '';
    if (value.length === 0) {
      handlers.appendSystemMessage('RLM 最大深度：请输入 /rlm-max-depth <N> 设置（0 = 无限）。');
      return;
    }
    const depth = parseRlmMaxDepth(value);
    if (depth === null) {
      showToast('RLM 深度需为 0 或非负整数。', 'warning');
      return;
    }
    const client = await ensureSessionClient();
    if (!client) return;
    // The REST contract intentionally keeps the current enabled state while
    // updating maxDepth; this mirrors TUI /rlm-max-depth, which does not turn
    // RLM on as a side effect.
    const enabled = client.status.value.rlmEnabled === true;
    await runControlAction(
      () => client.switchRlm(enabled, depth),
      depth === 0 ? 'RLM 递归深度已设为无限。' : `RLM 最大深度已设为 ${depth}。`,
    );
  }

  async function dispatchFusionPlan(args?: string): Promise<void> {
    const value = args?.trim().toLowerCase() ?? '';
    if (value !== '' && value !== 'on' && value !== 'off') {
      showToast('用法：/fusionplan [on|off]', 'warning');
      return;
    }
    const client = await ensureSessionClient();
    if (!client) return;
    const currentlyFusion = client.status.value.planMode === true && client.status.value.planStrategy === 'fusion';
    const enabled = value === 'off' ? false : value === 'on' ? true : !currentlyFusion;
    await runControlAction(
      () => client.switchPlanMode(enabled, enabled ? 'fusion' : undefined),
      `融合计划模式已${enabled ? '开启' : '关闭'}`,
    );
  }

  async function dispatchRevoke(args?: string): Promise<void> {
    const count = parseRevokeCount(args);
    if (count === null) {
      showToast('用法：/revoke [正整数轮数]', 'warning');
      return;
    }
    const client = await ensureSessionClient();
    if (!client) return;
    if (client.isBusy.value) {
      showToast('当前回合正在运行，无法撤销。', 'error');
      return;
    }
    try {
      const ok = await client.undoHistory(count);
      if (!ok) return;
      // Undo mutates core context; refresh the rendered transcript before the
      // success toast so the user never sees confirmation against stale rows.
      await client.fetchSnapshot();
      showToast(`已撤销最近 ${count} 轮。`, 'success');
    } catch (error) {
      showToast(`撤销失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  async function dispatchSkill(name: string, args?: string): Promise<void> {
    // Skill activation is a session-scoped action: ensure a session exists first, same as SESSION_COMMANDS.
    const ready = await handlers.ensureSession?.();
    if (ready === false) return;
    const run =
      handlers.onSkill ??
      (async (n: string, a?: string) => {
        const c = getActiveWebClient();
        return c ? await c.activateSkill(n, a) : false;
      });
    let ok = false;
    try {
      ok = await run(name, args);
    } catch (error) {
      ok = false;
      showToast(`技能激活失败：${error instanceof Error ? error.message : String(error)}`, 'error');
      return;
    }
    if (ok) showToast(`技能已激活：/${name}`, 'success');
    else showToast(`技能激活失败：/${name}`, 'error');
  }

  async function onCommand(name: string, args?: string): Promise<void> {
    if ((SESSION_COMMANDS as readonly string[]).includes(name)) {
      const ready = await handlers.ensureSession?.();
      if (ready === false) return;
      handlers.sendCommand(name, args);
    } else if (name === 'wolfpack') {
      await dispatchWolfpack(args);
    } else if (name === 'rlm') {
      await dispatchRlm(args);
    } else if (name === 'rlm-max-depth') {
      await dispatchRlmMaxDepth(args);
    } else if (name === 'fusionplan') {
      await dispatchFusionPlan(args);
    } else if (name === 'revoke') {
      await dispatchRevoke(args);
    } else if (name === 'clear') {
      handlers.clearMessages();
    } else if (name === 'new') {
      handlers.onNew();
    } else if (name === 'help') {
      handlers.appendSystemMessage(slashHelpText());
    } else if (name === 'model') {
      if (!handlers.openModelPicker?.()) {
        handlers.appendSystemMessage(`当前模型：${handlers.currentModel?.() ?? 'unknown'}`);
      }
    } else if (name === 'status' || name === 'usage') {
      if (handlers.showInfo) {
        handlers.showInfo(name);
      } else {
        handlers.appendSystemMessage('请在对话页查看会话详情');
      }
    } else if (isSlashSkillName(name)) {
      await dispatchSkill(name, args);
    } else {
      // The dispatch failure path always toasts (no longer just a system message line);
      // not-connected / busy already toast inside the webClient's sendCommand, so this
      // covers the remaining unknown-command branch.
      showToast(`未知命令：/${name}`, 'error');
    }
  }

  return { onCommand };
}
