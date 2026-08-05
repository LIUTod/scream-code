import type { PermissionMode } from '../permission';
import { DynamicInjector } from './injector';

const AUTO_MODE_ENTER_REMINDER = [
  'Auto permission mode is active. Tool approvals will be handled automatically while this mode remains enabled.',
  '  - Continue normally without pausing for approval prompts.',
  '  - Do NOT call AskUserQuestion while auto mode is active. Make a reasonable decision and continue without asking the user.',
].join('\n');

const AUTO_MODE_EXIT_REMINDER = [
  'Auto permission mode is no longer active. Tool approvals and permission checks are back to the current mode.',
  '  - Continue normally, but expect approval prompts or denials when a tool requires them.',
].join('\n');

const ASK_MODE_ENTER_REMINDER = [
  'Ask mode is active — read-only Q&A. You are here to discuss, not to act.',
  '  - You may read files, search the codebase, and use the web to analyse.',
  '  - Do NOT modify any files, run shell commands, schedule work, or call MCP tools.',
  '  - Answer the user directly in conversation. If they want changes, they will ask and switch out of Ask mode.',
].join('\n');

const ASK_MODE_EXIT_REMINDER = [
  'Ask mode is no longer active. You may modify files and run commands again as the current permission mode allows.',
  '  - Resume normal work. The previous read-only Q&A constraint is lifted.',
].join('\n');

export class PermissionModeInjector extends DynamicInjector {
  protected override readonly injectionVariant = 'permission_mode';
  private lastMode: PermissionMode | undefined;

  getInjection(): string | undefined {
    const mode = this.agent.permission.mode;
    const previousMode = this.lastMode;

    if (mode === previousMode) return undefined;

    this.lastMode = mode;

    // Report both sides independently so cross-mode transitions (e.g.
    // auto -> ask) announce the mode being left AND the mode being entered.
    const parts: string[] = [];
    if (mode === 'auto') parts.push(AUTO_MODE_ENTER_REMINDER);
    if (previousMode === 'auto') parts.push(AUTO_MODE_EXIT_REMINDER);
    if (mode === 'ask') parts.push(ASK_MODE_ENTER_REMINDER);
    if (previousMode === 'ask') parts.push(ASK_MODE_EXIT_REMINDER);
    return parts.length > 0 ? parts.join('\n\n') : undefined;
  }
}
