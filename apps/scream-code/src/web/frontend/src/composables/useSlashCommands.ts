import { isSlashSkillName, slashHelpText } from '../commands';
import { useToast } from './useToast';
import { getActiveWebClient } from './webClient/activeClient';

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
 * - Session-scoped commands (`compact`/`auto`/`yes`/`bot`/`plan`/`fork`/
 *   `title`/`btw`) create a session first when none is active (previously
 *   the chat view assumed one existed).
 * - Unknown commands now go through toast; names matching an injected skill go through the skill activation channel.
 */

/** Commands forwarded verbatim to the active WS session.
 *  L3 cross-check against the server handleCommand (web/server.ts): compact/auto/yes/bot/
 *  plan/fork/title/btw are all implemented; `bot` was previously missing from the frontend
 *  list, so dispatch fell into the unknown-command branch (a dead command) — it has now been
 *  added to the forwarding list. */
const SESSION_COMMANDS = ['compact', 'auto', 'yes', 'bot', 'plan', 'fork', 'title', 'btw'] as const;

export interface SlashCommandHandlers {
  sendCommand: (name: string, args?: string) => void;
  clearMessages: () => void;
  appendSystemMessage: (text: string) => void;
  /** Create/await a session when none is active so a session command can be sent. Omit where a session always exists. */
  ensureSession?: () => void | Promise<void>;
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

  async function dispatchSkill(name: string, args?: string): Promise<void> {
    // Skill activation is a session-scoped action: ensure a session exists first, same as SESSION_COMMANDS.
    await handlers.ensureSession?.();
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
      await handlers.ensureSession?.();
      handlers.sendCommand(name, args);
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
