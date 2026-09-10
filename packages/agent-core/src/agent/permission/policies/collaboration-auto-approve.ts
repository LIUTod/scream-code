import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../types';

/**
 * Coordination tools are conversation, not mutation: a subagent asking its
 * parent for context, reporting a finding, or a parent steering a child must
 * never block on an approval prompt (especially in unattended runs). This
 * policy auto-approves them in every mode; user-configured deny rules still
 * win because this policy is installed after them.
 */
const COORDINATION_TOOLS = new Set(['ContactParent', 'ReportFinding', 'SendSubagentMessage']);

export class CollaborationAutoApprovePermissionPolicy implements PermissionPolicy {
  readonly name = 'collaboration-auto-approve';

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    if (!COORDINATION_TOOLS.has(context.toolCall.name)) return;
    return { kind: 'approve', reason: { reason: 'coordination request' } };
  }
}
