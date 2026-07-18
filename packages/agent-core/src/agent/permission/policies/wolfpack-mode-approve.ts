import type { Agent } from '../..';
import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../types';

/** Tools that spawn subagents and should be auto-approved when WolfPack is active. */
const WOLFPACK_SPAWN_TOOLS = new Set(['WolfPack', 'Agent', 'FusionPlan']);

export class WolfPackModeApprovePermissionPolicy implements PermissionPolicy {
  readonly name = 'wolfpack-mode-approve';

  constructor(private readonly agent: Agent) {}

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    if (!this.agent.wolfpackMode?.isActive) return;
    if (!WOLFPACK_SPAWN_TOOLS.has(context.toolCall.name)) return;
    return { kind: 'approve' };
  }
}
