import type { Agent } from '../..';
import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../types';

/**
 * yolo mode → approve every tool operation: no approval prompt fires while
 * yolo is active (egress, dangerous commands, sensitive paths included).
 * ExitPlanMode is deliberately exempt — a plan decision is not a tool
 * operation, so the chain falls through to `session-approval-history` /
 * `exit-plan-mode-review-ask` and yolo keeps plan decisions with the user.
 */
export class YoloModeApprovePermissionPolicy implements PermissionPolicy {
  readonly name = 'yolo-mode-approve';

  constructor(private readonly agent: Agent) {}

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    if (this.agent.permission.mode !== 'yolo') return;
    if (context.toolCall.name === 'ExitPlanMode') return;
    return {
      kind: 'approve',
    };
  }
}
