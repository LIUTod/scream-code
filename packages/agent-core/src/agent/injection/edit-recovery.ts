import type { EditRecoveryReminder } from '../../tools/support/edit-recovery-queue';
import { DynamicInjector } from './injector';

const EDIT_RECOVERY_VARIANT = 'edit_recovery_reminder';
/** Signatures rendered per reminder; the remainder is summarised. */
const MAX_RENDERED_SIGNATURES = 5;

/**
 * Re-surfaces errors a successful Edit introduced until they are fixed. The
 * block is re-rendered when the pending set changes, not on a timer: an
 * unchanged queue is injected once and stays in the context history.
 *
 * The content comes from `agent.editRecoveryQueue` (see EditTool's
 * diagnostics tracking), not from any state held here: the queue survives
 * compaction and tool-result elision, and it is drained — not cleared — so an
 * unresolved reminder keeps appearing while fixes are still pending.
 *
 * Rendering follows the todo-list/goal injectors: `getInjection` returns the
 * plain text and the base class hands it to
 * `ContextMemory.appendSystemReminder`, which wraps it in
 * `<system-reminder>` tags (context/index.ts:234-242).
 */
export class EditRecoveryInjector extends DynamicInjector {
  protected override readonly injectionVariant = EDIT_RECOVERY_VARIANT;
  /**
   * Last rendered reminder block. `inject()` runs before every LLM step, so an
   * unchanged queue must not re-append the same text each step (the exact
   * anti-pattern documented on WorkingSetInjector). Suppression only applies
   * while the previous copy is still in the context (`injectedAt !== null`);
   * a clear/compaction resets it and the reminder is re-sent.
   */
  private lastInjectedText: string | null = null;

  protected override getInjection(): string | undefined {
    const reminders = this.agent.editRecoveryQueue.drain();
    if (reminders.length === 0) return undefined;
    const text = reminders.map(renderReminder).join('\n\n');
    if (this.injectedAt !== null && text === this.lastInjectedText) return undefined;
    this.lastInjectedText = text;
    return text;
  }
}

/**
 * `Note: the edit to <path> introduced N error(s): <file:line: message; …>.
 * Fix these before continuing.` — at most five signatures are listed, the
 * rest collapse into `…and N more`.
 */
function renderReminder(reminder: EditRecoveryReminder): string {
  const shown = reminder.signatures.slice(0, MAX_RENDERED_SIGNATURES);
  const hidden = reminder.signatures.length - shown.length;
  const errors = shown
    .map(
      (signature) =>
        `${reminder.displayPath}:${String(signature.line)}: ${signature.message}`,
    )
    .join('; ');
  const tail = hidden > 0 ? `; …and ${String(hidden)} more` : '';
  return (
    `Note: the edit to ${reminder.displayPath} introduced ` +
    `${String(reminder.signatures.length)} error(s): ${errors}${tail}. ` +
    reminder.instruction
  );
}
