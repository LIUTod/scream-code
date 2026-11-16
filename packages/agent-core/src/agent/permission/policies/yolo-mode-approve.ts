import type { Agent } from '../..';
import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../types';

/**
 * yolo mode → approve every tool operation that reaches it: dangerous
 * commands and sensitive paths included. The few operations whose damage
 * outlives the session (private-read egress, git control writes, shell
 * startup files) are stopped one line above by `yolo-hard-floor-ask`.
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
