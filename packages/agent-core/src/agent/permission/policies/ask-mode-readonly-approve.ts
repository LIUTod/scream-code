import { READ_TOOLS } from '#/tools/tool-catalog';

import type { Agent } from '../..';
import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../types';

/**
 * Tools the catalog files under "read-only" whose read-only-ness is decided by
 * their arguments, not by the tool. `LSP` looks up symbols and also renames
 * them (`operation: rename` with `apply: true`) or applies code actions; a
 * blanket approval would quietly turn ask mode — a read-only Q&A contract — into
 * a way to edit files. Those keep falling through to the approval prompt.
 */
const ARGUMENT_DEPENDENT_READ_TOOLS: ReadonlySet<string> = new Set(['LSP']);

/**
 * Ask mode: a tool the catalog classifies as read-only runs without a prompt.
 *
 * Ask mode's own guard denies the mutating tools outright, so what is left for
 * this policy is exactly the read half of the contract — and asking a person
 * about a read is the one prompt that cannot be worth it. The gap it closes is
 * concrete: only 14 of the catalog's read tools were in the default-approve
 * list, so `ReadGroup`, `AstGrep`, `MemoryLookup`, `KnowledgeLookup`,
 * `ReportFinding` and friends fell through to `fallback-ask`. In a background
 * run that has no approval handler (`Approval handler is unavailable.`), that
 * prompt is not a question — it is a silent refusal, and a scheduled report job
 * loses tools it could only ever use for reading.
 *
 * Ordering: every policy that may legitimately tighten a read — a user deny or
 * ask rule, a sensitive-file access, a path outside the workspace, a
 * destructive hint — sits above this one, so this approves the residue, not the
 * whole class. Tools that are not in the catalog are untouched.
 */
export class AskModeReadOnlyApprovePermissionPolicy implements PermissionPolicy {
  readonly name = 'ask-mode-readonly-approve';

  constructor(private readonly agent: Agent) {}

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    if (this.agent.permission.mode !== 'ask') return;
    const toolName = context.toolCall.name;
    if (!READ_TOOLS.has(toolName)) return;
    if (ARGUMENT_DEPENDENT_READ_TOOLS.has(toolName)) return;
    return { kind: 'approve' };
  }
}
