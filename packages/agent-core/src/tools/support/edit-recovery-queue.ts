/**
 * Session-scoped queue of post-edit error reminders.
 *
 * A successful Edit can leave a file with language-server errors it did not
 * have before. Appending the diagnostics notice to the tool output is not
 * enough on its own: that notice lives in one tool result, so compaction,
 * micro-compaction elision or simply a model that moves on takes it away.
 * This queue is the survivable half — EditRecoveryInjector re-renders the
 * pending items into the prompt every turn until the errors are gone.
 *
 * EditTool writes (diffing each diagnostics observation against the file's
 * last-seen set) and the injector reads, so the class lives next to
 * EditSnapshotStore, the other session-scoped store the file tools write and
 * the agent holds. One instance per Agent: subagents never share queues.
 */

import type { LspDiagnostic } from '../../lsp/client';

/**
 * Closing sentence rendered after the signature list. Part of the queue item
 * so a future producer can word its own reminder without touching the
 * injector.
 */
export const EDIT_RECOVERY_INSTRUCTION = 'Fix these before continuing.';

export interface EditRecoverySignature {
  /** Stable identity: `${severity}:${message}:${lspLine}` (LSP 0-based line). */
  readonly signature: string;
  /** 1-based line for the rendered note. */
  readonly line: number;
  readonly message: string;
}

export interface EditRecoveryReminder {
  /** Canonical absolute path — the queue key and the resolution key. */
  readonly path: string;
  /** Path as the model wrote it, rendered in the note. */
  readonly displayPath: string;
  /** Every error signature the edit introduced, in line order. */
  readonly signatures: readonly EditRecoverySignature[];
  /** Closing instruction rendered after the signature list. */
  readonly instruction: string;
}

/**
 * Pending post-edit error reminders.
 *
 * Items are never cleared by reading them: the injector renders whatever is
 * pending on each turn, and only an observation that no longer reports the
 * signatures removes the item. Two enqueues with the same path and the same
 * signature set collapse into one item.
 */
export class EditRecoveryQueue {
  private readonly items = new Map<string, EditRecoveryReminder>();

  /** Number of pending reminders. */
  get size(): number {
    return this.items.size;
  }

  /**
   * Add a reminder. The identity is the path plus the canonical (sorted)
   * signature set, so identical re-enqueues replace rather than duplicate.
   * An empty signature list is ignored — there is nothing to report.
   */
  enqueue(reminder: EditRecoveryReminder): void {
    if (reminder.signatures.length === 0) return;
    this.items.set(reminderKey(reminder), reminder);
  }

  /** Snapshot of the pending reminders, oldest first. Does not clear them. */
  drain(): readonly EditRecoveryReminder[] {
    return [...this.items.values()];
  }

  /**
   * Drop the path's reminders whose signatures are all absent from the
   * current observation — the errors they reported are fixed. A reminder
   * that still has at least one live signature stays pending (the edit's
   * remaining errors are still worth surfacing).
   */
  clearIfResolved(path: string, current: ReadonlySet<string>): void {
    for (const [key, reminder] of this.items) {
      if (reminder.path !== path) continue;
      if (reminder.signatures.every((signature) => !current.has(signature.signature))) {
        this.items.delete(key);
      }
    }
  }
}

/**
 * Canonical item identity. Joining the sorted signatures is collision-free
 * (no hashing needed for a Map key) and independent of the order in which
 * the language server reported them.
 */
function reminderKey(reminder: EditRecoveryReminder): string {
  const signatures = reminder.signatures
    .map((signature) => signature.signature)
    .toSorted();
  return `${reminder.path}\u0000${signatures.join('\u0001')}`;
}

/**
 * Error-severity diagnostics as stable identities: severity, message text and
 * the (0-based) start line. Warnings are ignored — the reminder is about
 * errors an edit introduced, and a file's warning set churns on nearly every
 * edit. Duplicates within one publication collapse into a single identity.
 */
export function diagnosticsSignatures(
  diagnostics: readonly LspDiagnostic[],
): readonly EditRecoverySignature[] {
  const seen = new Set<string>();
  const signatures: EditRecoverySignature[] = [];
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity !== 1) continue;
    const line = diagnostic.range.start.line;
    const signature = `${String(diagnostic.severity)}:${diagnostic.message}:${String(line)}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    // 1-based for rendering, matching the `file:line` shape of the notice.
    signatures.push({ signature, line: line + 1, message: diagnostic.message });
  }
  return signatures.toSorted((a, b) => a.line - b.line);
}
