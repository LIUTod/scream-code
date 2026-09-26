import { DEFAULT_AUTO_APPROVE_TOOLS } from '#/tools/tool-catalog';

import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../types';

export class DefaultToolApprovePermissionPolicy implements PermissionPolicy {
  readonly name = 'default-tool-approve';

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    if (!DEFAULT_AUTO_APPROVE_TOOLS.has(context.toolCall.name)) return;
    return {
      kind: 'approve',
    };
  }
}
