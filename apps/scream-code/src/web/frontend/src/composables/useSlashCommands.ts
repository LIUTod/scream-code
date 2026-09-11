import { slashHelpText } from '../commands';

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
 * - Session-scoped commands (`compact`/`auto`/`yes`/`plan`/`fork`/`title`/
 *   `btw`) create a session first when none is active (previously the chat
 *   view assumed one existed).
 */

/** Commands forwarded verbatim to the active WS session. */
const SESSION_COMMANDS = ['compact', 'auto', 'yes', 'plan', 'fork', 'title', 'btw'] as const;

export interface SlashCommandHandlers {
  sendCommand: (name: string, args?: string) => void;
  clearMessages: () => void;
  appendSystemMessage: (text: string) => void;
  /** Create/await a session when none is active so a session command can be sent. Omit where a session always exists. */
  ensureSession?: () => void | Promise<void>;
  /** `new` — context-specific fresh start (shell: create session; chat: back to home). */
  onNew: () => void;
  /** `model` — open the picker; return false (or omit) to fall back to a status message. */
  openModelPicker?: () => boolean;
  /** `status` / `usage` — open the richer info view; omit to keep the plain hint message. */
  showInfo?: (mode: 'status' | 'usage') => void;
  /** Current model name, read lazily for the picker's fallback message. */
  currentModel?: () => string | null | undefined;
}

export function useSlashCommands(handlers: SlashCommandHandlers) {
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
    } else {
      handlers.appendSystemMessage(`未知命令：/${name}`);
    }
  }

  return { onCommand };
}
