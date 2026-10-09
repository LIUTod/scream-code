import type { Agent } from '../..';
import { isToolAllowedForCapability } from '../../../session/subagent-capability';
import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../types';

/**
 * Hard capability gate for restricted subagents.
 *
 * `read-only` / `read-write` / `execute` are enforced twice: the spawn-time
 * trim (`filterToolsForCapability`) removes what the model SEES, and this
 * policy refuses what may RUN. A call can still arrive for a tool that is not
 * in the active list (a replayed turn, a plugin-provided name, a stale
 * schema), and an approval policy later in the chain must never widen a
 * restricted contract — the parent may spawn the child restricted, but the
 * child itself cannot talk its way past the trim.
 *
 * Both sides ask `isToolAllowedForCapability`, so visibility and execution
 * cannot drift: an unclassified tool name is refused here exactly as it is
 * stripped there, and MCP tools stay fail-closed.
 *
 * The mode is read off the asking agent instance (`all` for main agents and
 * unrestricted subagents, so this policy is inert for them). Because the
 * refusal lives in the permission layer rather than in each tool, it also
 * covers tools that keep a conditional write path (e.g. LSP rename with
 * `apply: true`) without every such tool re-implementing the check.
 */
export class CapabilityGuardDenyPermissionPolicy implements PermissionPolicy {
  readonly name = 'capability-guard-deny';

  constructor(private readonly agent: Agent) {}

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    const mode = this.agent.getCapabilityMode();
    if (mode === 'all') return undefined;

    const toolName = context.toolCall.name;
    if (isToolAllowedForCapability(toolName, mode)) return undefined;

    return {
      kind: 'deny',
      message:
        `Tool "${toolName}" is not available to this agent: it runs under the "${mode}" capability contract, ` +
        'which permits only a fixed tool set. Do not retry the call or try to reach the same effect another way — ' +
        'report back to the parent agent instead (ContactParent); the parent can re-dispatch the work with a wider contract if it is needed.',
    };
  }
}
