import type { ToolCall } from '@scream-code/ltod';
import { describe, expect, it } from 'vitest';

import type { Agent } from '../../../src/agent';
import type { PermissionPolicyContext } from '../../../src/agent/permission';
import { matchPermissionRule } from '../../../src/agent/permission/matches-rule';
import { ManagePluginReadOnlyApprovePermissionPolicy } from '../../../src/agent/permission/policies/manage-plugin-read-only-approve';
import { SessionApprovalHistoryPermissionPolicy } from '../../../src/agent/permission/policies/session-approval-history';
import { ToolAccesses } from '../../../src/loop';
import type { RunnableToolExecution } from '../../../src/loop/types';
import {
  MANAGE_PLUGIN_READ_ONLY_ACTIONS,
  ManagePluginTool,
  type ManagePluginInput,
} from '../../../src/tools/builtin/plugin/manage-plugin';

const signal = new AbortController().signal;

/**
 * `resolveExecution` only reads the tool name and the arguments, so an empty
 * agent is enough to derive a genuine execution (approval rule, description,
 * matcher) without building a whole session.
 */
const tool = new ManagePluginTool({} as Agent);

function argsFor(action: ManagePluginInput['action']): ManagePluginInput {
  switch (action) {
    case 'install':
      return { action, source: 'https://github.com/o/repo/tree/v1.2.0' };
    case 'register_generated':
      return { action, source: '/abs/path/to/generated/plugin' };
    case 'set_mcp_enabled':
      return { action, id: 'demo', server: 'finance', enabled: false };
    case 'marketplace':
      return { action, source: '/abs/path/catalog.json' };
    case 'list':
    case 'check':
    case 'reload':
      return { action };
    default:
      return { action, id: 'demo' };
  }
}

/** The real execution for an action, or the preflight error it was rejected with. */
function executionFor(action: ManagePluginInput['action']): RunnableToolExecution {
  return executionForArgs(argsFor(action));
}

/**
 * Resolve a genuine execution from literal args. `matchesRule` closes over the
 * args it was resolved from, so a "different source" case must be resolved
 * rather than patched onto an existing execution.
 */
function executionForArgs(args: ManagePluginInput): RunnableToolExecution {
  const execution = tool.resolveExecution(args);
  if (execution.isError === true) {
    throw new TypeError(
      `args ${JSON.stringify(args)} were expected to resolve, got: ${execution.output}`,
    );
  }
  return execution;
}

function policyContext(
  toolName: string,
  args: unknown,
  execution: RunnableToolExecution,
): PermissionPolicyContext {
  return {
    turnId: '0',
    stepNumber: 1,
    signal,
    llm: {},
    args,
    toolCall: {
      type: 'function',
      id: 'call_manage_plugin',
      name: toolName,
      arguments: JSON.stringify(args),
    } satisfies ToolCall,
    execution: {
      accesses: execution.accesses,
      description: execution.description,
      approvalRule: execution.approvalRule,
      matchesRule: execution.matchesRule,
      execute: execution.execute,
    },
  } as unknown as PermissionPolicyContext;
}

function contextForAction(action: ManagePluginInput['action']): PermissionPolicyContext {
  const args = argsFor(action);
  return policyContext('ManagePlugin', args, executionFor(action));
}

describe('ManagePluginReadOnlyApprovePermissionPolicy', () => {
  const policy = new ManagePluginReadOnlyApprovePermissionPolicy();

  it('auto-approves every read-only action and names it in the reason', () => {
    for (const action of MANAGE_PLUGIN_READ_ONLY_ACTIONS) {
      expect(policy.evaluate(contextForAction(action)), action).toEqual({
        kind: 'approve',
        reason: { manage_plugin_action: action },
      });
    }
  });

  it('decides nothing for a mutating action so the chain keeps falling through', () => {
    const mutating: ManagePluginInput['action'][] = [
      'install',
      'register_generated',
      'enable',
      'disable',
      'set_mcp_enabled',
      'activate',
      'deactivate',
      'remove',
      'reload',
    ];
    for (const action of mutating) {
      expect(policy.evaluate(contextForAction(action)), action).toBeUndefined();
    }
  });

  it('leaves the source string visible in the approval description', () => {
    const install = executionFor('install');
    expect(install.description).toContain('https://github.com/o/repo/tree/v1.2.0');
    expect(install.description).toContain('not executed');

    const register = executionFor('register_generated');
    expect(register.description).toContain('/abs/path/to/generated/plugin');

    // `activate` is the code-execution step and must say so to the user.
    expect(executionFor('activate').description).toContain('code');
  });

  it('ignores every other tool', () => {
    const context = policyContext('Bash', { action: 'list' }, executionFor('list'));
    expect(policy.evaluate(context)).toBeUndefined();
  });

  it('fails open to "ask" when the action is missing, unknown, or unparseable', () => {
    const list = executionFor('list');
    const cases: unknown[] = [
      {},
      { action: undefined },
      { action: 'install' },
      { action: 42 },
    ];
    for (const args of cases) {
      const context = policyContext('ManagePlugin', args, list);
      expect(policy.evaluate(context), JSON.stringify(args)).toBeUndefined();
    }
  });

  it('reads the action from the raw tool-call arguments when resolved args are absent', () => {
    const context = contextForAction('info');
    const bare = { ...context, args: undefined };
    expect(policy.evaluate(bare as PermissionPolicyContext)).toEqual({
      kind: 'approve',
      reason: { manage_plugin_action: 'info' },
    });
  });

  it('ignores a tool call whose raw arguments are not JSON', () => {
    const context = contextForAction('list');
    const broken = {
      ...context,
      args: undefined,
      toolCall: { ...context.toolCall, arguments: 'not-json' },
    } as unknown as PermissionPolicyContext;
    expect(policy.evaluate(broken)).toBeUndefined();
  });
});

describe('ManagePlugin session approval granularity', () => {
  /**
   * The mutating actions publish a per-action `approvalRule`
   * (`ManagePlugin(enable)`), and the source-scoped ones fold the source into
   * it. This is the proof that a memorized grant cannot be replayed against a
   * different action — or a different URL.
   */
  function sessionPolicy(approvedPatterns: readonly string[]): SessionApprovalHistoryPermissionPolicy {
    const agent = {
      permission: { sessionApprovalRulePatterns: approvedPatterns },
    } as unknown as Agent;
    return new SessionApprovalHistoryPermissionPolicy(agent);
  }

  it('replays a memorized enable only for the same action', () => {
    const grant = executionFor('enable').approvalRule ?? '';
    expect(grant).toBe('ManagePlugin(enable)');
    const policy = sessionPolicy([grant]);

    expect(policy.evaluate(contextForAction('enable'))?.kind).toBe('approve');
    for (const action of ['disable', 'remove', 'activate', 'reload'] as const) {
      expect(policy.evaluate(contextForAction(action)), action).toBeUndefined();
    }
  });

  it('replays a memorized install only for the exact same source', () => {
    const grant = executionFor('install').approvalRule ?? '';
    expect(grant).toContain('install https://github.com/o/repo/tree/v1.2.0');
    const policy = sessionPolicy([grant]);

    expect(policy.evaluate(contextForAction('install'))?.kind).toBe('approve');

    const otherArgs: ManagePluginInput = { action: 'install', source: 'https://github.com/evil/repo' };
    const otherSource = policyContext('ManagePlugin', otherArgs, executionForArgs(otherArgs));
    // Same action, different URL: the stored rule must not match.
    expect(matchPermissionRule({
      rule: { decision: 'allow', scope: 'session-runtime', pattern: grant },
      toolName: 'ManagePlugin',
      execution: otherSource.execution,
    })).toBeUndefined();
    expect(policy.evaluate(otherSource)).toBeUndefined();
  });

  it('keeps read-only actions on their own rule so they never borrow a write grant', () => {
    const writeGrant = executionFor('install').approvalRule ?? '';
    const policy = sessionPolicy([writeGrant]);
    expect(policy.evaluate(contextForAction('list'))).toBeUndefined();
  });
});

describe('ManagePlugin approval identity plumbing', () => {
  it('declares a distinct rule per action', () => {
    const rules = [
      'list', 'info', 'check', 'marketplace', 'install', 'register_generated', 'enable',
      'disable', 'set_mcp_enabled', 'activate', 'deactivate', 'remove', 'reload',
    ] as const;
    const subjects = rules.map((action) => executionFor(action).approvalRule);
    expect(new Set(subjects).size).toBe(rules.length);
  });

  it('declares no side effects for read-only actions and all of them for writes', () => {
    expect(executionFor('list').accesses).toEqual(ToolAccesses.none());
    expect(executionFor('activate').accesses).toEqual(ToolAccesses.all());
  });
});
