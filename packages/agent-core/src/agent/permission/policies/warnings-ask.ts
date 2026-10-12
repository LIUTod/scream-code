import type { Agent } from '../..';
import { dangerousCommandWarnings } from '../warnings';
import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../types';

/**
 * Dangerous shell commands ask before running in manual mode — auto and yolo
 * approve above this policy, and ask mode's guard denies above it, so the
 * warning only ever fires where a prompt is expected.
 *
 * The prompt offers `once` and `session`. A session grant is memorized as the
 * rule the approved command records (`Bash(rm -rf ./dist)`, or the family
 * template of a curated family), so re-running that same command stops
 * asking. Only that identical rule silences the warning — a tool-wide `Bash`
 * grant, or a family template recorded from a different family member
 * (`git push *` approved via `git push origin main`), never does.
 *
 * The chain position is the mechanism (see `createPermissionDecisionPolicies`):
 * the policy sits after `auto-mode-approve`, so unattended auto mode keeps
 * running without prompts, and before `session-approval-history`, so the
 * blanket approve that policy performs cannot silence the warning before this
 * policy applies its own exact-command check.
 */
export class WarningsAskPermissionPolicy implements PermissionPolicy {
  readonly name = 'dangerous-command-warnings-ask';

  constructor(private readonly agent: Agent) {}

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    if (context.toolCall.name !== 'Bash') return;
    const command = (context.args as { command?: unknown } | undefined)?.command;
    if (typeof command !== 'string') return;
    const warnings = dangerousCommandWarnings(command);
    if (warnings.length === 0) return;
    if (this.memorizedCommandGrant(context)) return;
    return {
      kind: 'ask',
      reason: {
        dangerous_command: true,
        warning_count: warnings.length,
      },
      reasons: warnings,
      grantOptions: ['once', 'session'],
    };
  }

  /**
   * A session grant silences the warning only when it is the very rule this
   * call records (`Bash(rm -rf ./dist)`, or the family template of a curated
   * family) — the user already approved this command for the session. A grant
   * recorded for a *different* command never counts: neither a tool-wide
   * `Bash` grant (a legacy wire record) nor a family template recorded from a
   * benign family member (`git push *` approved via `git push origin main`)
   * may turn `git push --force` silent.
   */
  private memorizedCommandGrant(context: PermissionPolicyContext): boolean {
    return this.agent.permission.sessionApprovalRulePatterns.some(
      (pattern) => pattern === context.execution.approvalRule,
    );
  }
}
