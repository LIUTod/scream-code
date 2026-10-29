import type { PermissionMode } from '../permission';
import { DynamicInjector } from './injector';

const AUTO_MODE_ENTER_REMINDER = [
  'Auto permission mode is active. Tool approvals will be handled automatically while this mode remains enabled.',
  '  - Continue normally without pausing for approval prompts.',
  '  - Do NOT call AskUserQuestion while auto mode is active — the tool is blocked. When a decision genuinely requires the user, stop that direction, state the question and your recommended option in a normal text reply, and end the turn; otherwise decide and continue.',
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

const BOT_MODE_ENTER_REMINDER = [
  'Bot permission mode is active — unattended execution.',
  '  - Reversible work (reads, in-workspace edits, read-only commands) runs without approval.',
  '  - Irreversible actions (push, publish, delete, sensitive files, unclassified operations) are denied automatically and queued for the user to review; the denial reason is returned to you.',
  '  - Do not retry a denied call unchanged. Continue with what is allowed and report what needs the user.',
].join('\n');

const BOT_MODE_EXIT_REMINDER = [
  'Bot permission mode is no longer active. Approval handling is back to the current mode.',
].join('\n');

const YOLO_MODE_ENTER_REMINDER = [
  'Yolo permission mode is active — every tool call is approved automatically, including irreversible ones.',
  '  - Nothing will stop you, so verify destructive operations yourself before running them.',
].join('\n');

const YOLO_MODE_EXIT_REMINDER = [
  'Yolo permission mode is no longer active. Approvals follow the current mode again.',
].join('\n');

const MANUAL_MODE_ENTER_REMINDER = [
  'Manual permission mode is active — tool calls that need approval will ask the user.',
  '  - Expect waits on approval; state intent before long or destructive operations.',
].join('\n');

export class PermissionModeInjector extends DynamicInjector {
  protected override readonly injectionVariant = 'permission_mode';
  private lastMode: PermissionMode | undefined;

  // Context maintenance resets the marker too: the reminder only lives in the
  // context, so after /clear, /undo of the reminder message, or a compaction
  // that drops it, the next pass must re-announce the current mode instead of
  // silently losing the awareness until the user happens to switch again.
  override onContextClear(): void {
    super.onContextClear();
    this.lastMode = undefined;
  }

  override onContextCompacted(compactedCount: number): void {
    super.onContextCompacted(compactedCount);
    this.lastMode = undefined;
  }

  override onContextMessageRemoved(index: number): void {
    super.onContextMessageRemoved(index);
    this.lastMode = undefined;
  }

  getInjection(): string | undefined {
    const mode = this.agent.permission.mode;
    const previousMode = this.lastMode;

    // A same-value sync is a no-op: without this short-circuit every injector
    // pass would re-announce the current mode.
    if (mode === previousMode) return undefined;

    this.lastMode = mode;

    // Report both sides independently so cross-mode transitions (e.g.
    // auto -> ask) announce the mode being left AND the mode being entered.
    const parts: string[] = [];
    if (mode === 'auto') parts.push(AUTO_MODE_ENTER_REMINDER);
    if (previousMode === 'auto') parts.push(AUTO_MODE_EXIT_REMINDER);
    if (mode === 'ask') parts.push(ASK_MODE_ENTER_REMINDER);
    if (previousMode === 'ask') parts.push(ASK_MODE_EXIT_REMINDER);
    if (mode === 'bot') parts.push(BOT_MODE_ENTER_REMINDER);
    if (previousMode === 'bot') parts.push(BOT_MODE_EXIT_REMINDER);
    if (mode === 'yolo') parts.push(YOLO_MODE_ENTER_REMINDER);
    if (previousMode === 'yolo') parts.push(YOLO_MODE_EXIT_REMINDER);
    // Manual is the default at session start, so only announce a return to it.
    if (mode === 'manual' && previousMode !== undefined) parts.push(MANUAL_MODE_ENTER_REMINDER);
    return parts.length > 0 ? parts.join('\n\n') : undefined;
  }
}
