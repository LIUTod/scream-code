import type { Agent } from '../..';
import { dangerousCommandWarnings } from '../warnings';
import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../types';

/**
 * Dangerous shell commands always ask — even in `yolo` mode and even when a
 * session grant already covers Bash.
 *
 * The chain position is the mechanism (see `createPermissionDecisionPolicies`):
 * the policy sits after `auto-mode-approve`, so unattended auto mode keeps
 * running without prompts, and before `session-approval-history`, so a
 * memorized grant cannot silence the warning. The prompt offers `once` only —
 * a dangerous command is never memorizable.
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
    return {
      kind: 'ask',
      reason: {
        dangerous_command: true,
        warning_count: warnings.length,
      },
      reasons: warnings,
      grantOptions: ['once'],
    };
  }
}
