import type { Agent } from '../..';
import { isMcpToolName } from '../../../mcp/tool-naming';
import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../types';

/**
 * Denies every mutating tool while ask mode is active. Ask mode is a
 * read-only Q&A mode: the model may read, search, and analyse, then answer
 * in conversation — it must never modify the filesystem, run shell commands,
 * schedule work, or reach a mutating MCP server tool. The deny messages are
 * deliberately instructive: they tell the model what ask mode is for and
 * point it back to answering, so a blocked call converges instead of looping.
 */
export class AskModeGuardDenyPermissionPolicy implements PermissionPolicy {
  readonly name = 'ask-mode-guard-deny';

  constructor(private readonly agent: Agent) {}

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    if (this.agent.permission.mode !== 'ask') return;

    const toolName = context.toolCall.name;

    if (toolName === 'Bash') {
      return {
        kind: 'deny',
        message:
          'Bash is not available in Ask mode — it could modify the system. ' +
          'Ask mode is read-only Q&A: answer the user directly in conversation instead of running commands.',
      };
    }

    if (toolName === 'Write' || toolName === 'Edit') {
      return {
        kind: 'deny',
        message:
          `${toolName} is not available in Ask mode. Ask mode is read-only Q&A: ` +
          'answer the user directly in conversation instead of modifying files. ' +
          'Exit Ask mode when you are ready to make changes.',
      };
    }

    if (toolName === 'CronCreate' || toolName === 'CronDelete') {
      return {
        kind: 'deny',
        message:
          `${toolName} is not available in Ask mode because it schedules work that mutates the system. ` +
          'Answer the user directly in conversation instead.',
      };
    }

    if (toolName === 'TaskStop') {
      return {
        kind: 'deny',
        message:
          'TaskStop is not available in Ask mode. Answer the user directly in conversation instead.',
      };
    }

    if (isMcpToolName(toolName)) {
      return {
        kind: 'deny',
        message:
          `${toolName} is not available in Ask mode — MCP tools may mutate external systems. ` +
          'Answer the user directly in conversation instead.',
      };
    }

    return;
  }
}
