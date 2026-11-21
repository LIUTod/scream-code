import type { ToolCall } from '@scream-code/ltod';
import { describe, expect, it } from 'vitest';

import type { Agent } from '../../../src/agent';
import type { PermissionMode, PermissionPolicyContext } from '../../../src/agent/permission';
import { AskModeReadOnlyApprovePermissionPolicy } from '../../../src/agent/permission/policies/ask-mode-readonly-approve';
import { ToolAccesses } from '../../../src/loop';

const signal = new AbortController().signal;

function agentIn(mode: PermissionMode): Agent {
  return { permission: { mode } } as unknown as Agent;
}

function policyContext(toolName: string, args: unknown = {}): PermissionPolicyContext {
  return {
    turnId: '0',
    stepNumber: 1,
    signal,
    llm: {} as never,
    args,
    toolCall: {
      type: 'function',
      id: `call_${toolName}`,
      name: toolName,
      arguments: JSON.stringify(args),
    } satisfies ToolCall,
    execution: {
      accesses: ToolAccesses.none(),
      approvalRule: toolName,
      execute: async () => ({ output: '' }),
    },
  } as unknown as PermissionPolicyContext;
}

describe('AskModeReadOnlyApprovePermissionPolicy', () => {
  it('approves the read tools ask mode used to send to a prompt', () => {
    const policy = new AskModeReadOnlyApprovePermissionPolicy(agentIn('ask'));
    // The catalog's read tools that were missing from the default-approve list,
    // plus two that were already covered — the policy must be a no-op for a tool
    // another policy already handles, never a conflict.
    const readTools = [
      'ReadGroup',
      'AstGrep',
      'MemoryLookup',
      'KnowledgeLookup',
      'ReportFinding',
      'ReportArchFinding',
      'Read',
      'Grep',
      'Skill',
    ];
    for (const toolName of readTools) {
      expect(policy.evaluate(policyContext(toolName)), toolName).toEqual({ kind: 'approve' });
    }
  });

  it('leaves LSP to the prompt, because one of its operations writes', () => {
    const policy = new AskModeReadOnlyApprovePermissionPolicy(agentIn('ask'));
    // `rename` with apply=true edits files; the whole tool stays argument-gated
    // rather than widening ask mode's read-only contract by classification.
    expect(policy.evaluate(policyContext('LSP', { operation: 'rename', apply: true }))).toBeUndefined();
    expect(policy.evaluate(policyContext('LSP', { operation: 'hover' }))).toBeUndefined();
  });

  it('never approves a tool outside the read-only catalog', () => {
    const policy = new AskModeReadOnlyApprovePermissionPolicy(agentIn('ask'));
    for (const toolName of ['Write', 'Edit', 'Bash', 'JobCreate', 'MemoryWrite', 'TaskStop']) {
      expect(policy.evaluate(policyContext(toolName)), toolName).toBeUndefined();
    }
  });

  it('is inert outside ask mode', () => {
    for (const mode of ['auto', 'bot', 'yolo'] as const) {
      const policy = new AskModeReadOnlyApprovePermissionPolicy(agentIn(mode));
      expect(policy.evaluate(policyContext('ReadGroup')), mode).toBeUndefined();
    }
  });
});
