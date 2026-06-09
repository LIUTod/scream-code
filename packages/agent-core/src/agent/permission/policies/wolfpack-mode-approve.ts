import type { Agent } from '../..';
import type { PermissionPolicy, PermissionPolicyResult } from '../types';

export class WolfPackModeApprovePermissionPolicy implements PermissionPolicy {
  readonly name = 'wolfpack-mode-approve';

  constructor(private readonly agent: Agent) {}

  evaluate(): PermissionPolicyResult | undefined {
    if (!this.agent.wolfpackMode?.isActive) return;
    return { kind: 'approve' };
  }
}
