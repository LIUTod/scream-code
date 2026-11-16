import type { Agent } from '../..';
import { isMcpToolName } from '../../../mcp/tool-naming';
import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../types';

/**
 * True when the tool is an MCP tool whose author declared it read-only.
 *
 * The declaration is author-supplied and unverified, which is exactly why it
 * only ever *widens a mode whose contract is already read-only* (ask mode), and
 * why a `destructiveHint` vetoes it. Nothing else consumes this helper.
 */
export function isDeclaredReadOnlyMcpTool(context: PermissionPolicyContext): boolean {
  const toolName = context.toolCall.name;
  if (!isMcpToolName(toolName)) return false;
  const annotations = context.tool?.annotations;
  return annotations?.readOnlyHint === true && annotations.destructiveHint !== true;
}

/**
 * Ask mode: run MCP tools the server declared read-only.
 *
 * Why this is a *separate* policy from `AskModeGuardDenyPermissionPolicy`: the
 * chain is first-match-wins, and that policy sits **above** user-configured deny
 * rules. Approving there would have let an author-declared hint override an
 * explicit `mcp__x__*: deny` rule the user wrote. Placed below the deny
 * policies, a user deny always wins and this only fills the remaining gap.
 */
export class AskModeReadOnlyMcpApprovePermissionPolicy implements PermissionPolicy {
  readonly name = 'ask-mode-readonly-mcp-approve';

  constructor(private readonly agent: Agent) {}

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    if (this.agent.permission.mode !== 'ask') return;
    if (!isDeclaredReadOnlyMcpTool(context)) return;
    return {
      kind: 'approve',
      reason: { readOnlyHint: true, tool: context.toolCall.name, policy: 'ask-mode-readonly-mcp' },
    };
  }
}
