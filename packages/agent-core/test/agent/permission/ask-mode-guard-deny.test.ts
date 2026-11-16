import type { ToolAnnotations, ToolCall } from '@scream-code/ltod';
import { describe, expect, it } from 'vitest';

import type { Agent } from '../../../src/agent';
import type { PermissionMode, PermissionPolicyContext } from '../../../src/agent/permission';
import { AskModeGuardDenyPermissionPolicy } from '../../../src/agent/permission/policies/ask-mode-guard-deny';
import { AskModeReadOnlyMcpApprovePermissionPolicy } from '../../../src/agent/permission/policies/ask-mode-readonly-mcp-approve';
import type { ExecutableTool } from '../../../src/loop';

const signal = new AbortController().signal;

function askAgent(mode: PermissionMode = 'ask'): Agent {
  return { permission: { mode } } as unknown as Agent;
}

function policyContext(
  toolName: string,
  args: unknown,
  annotations?: ToolAnnotations,
): PermissionPolicyContext {
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
      accesses: {} as never,
      approvalRule: toolName,
      execute: async () => ({ output: '' }),
    },
    // Only MCP-style tool hints matter to this policy; the rest of the
    // `ExecutableTool` surface is never read.
    ...(annotations === undefined
      ? {}
      : { tool: { name: toolName, annotations } as unknown as ExecutableTool }),
  } as PermissionPolicyContext;
}

function evaluateAskPolicy(
  agent: Agent,
  toolName: string,
  args: unknown,
  annotations?: ToolAnnotations,
) {
  return new AskModeGuardDenyPermissionPolicy(agent).evaluate(
    policyContext(toolName, args, annotations),
  );
}

const MUTATING_TOOLS = ['Bash', 'Write', 'Edit', 'CronCreate', 'CronDelete', 'TaskStop'];

describe('Ask mode permission policy', () => {
  it('denies mutating tools while ask mode is active', () => {
    const agent = askAgent('ask');
    for (const name of MUTATING_TOOLS) {
      const result = evaluateAskPolicy(agent, name, {});
      expect(result?.kind, name).toBe('deny');
      if (result?.kind === 'deny') {
        expect(result.message, name).toContain('Ask mode');
      }
    }
  });

  it('lets a declared read-only MCP tool fall through to the approve policy', () => {
    const agent = askAgent('ask');
    const context = policyContext('mcp__db__select', { sql: 'select 1' }, { readOnlyHint: true });

    // 不在这里 approve：本策略在用户 deny 规则之上，approve 会越过用户规则。
    expect(new AskModeGuardDenyPermissionPolicy(agent).evaluate(context)).toBeUndefined();

    const approved = new AskModeReadOnlyMcpApprovePermissionPolicy(agent).evaluate(context);
    expect(approved?.kind).toBe('approve');
    if (approved?.kind === 'approve') {
      expect(approved.reason?.['readOnlyHint']).toBe(true);
      expect(approved.reason?.['tool']).toBe('mcp__db__select');
    }
  });

  it('a destructive declaration vetoes the read-only approval', () => {
    const agent = askAgent('ask');
    const context = policyContext('mcp__db__drop', {}, {
      readOnlyHint: true,
      destructiveHint: true,
    });

    expect(new AskModeGuardDenyPermissionPolicy(agent).evaluate(context)?.kind).toBe('deny');
    expect(new AskModeReadOnlyMcpApprovePermissionPolicy(agent).evaluate(context)).toBeUndefined();
  });

  it('the approve policy only acts in ask mode', () => {
    for (const mode of ['yolo', 'auto', 'bot'] as const) {
      const context = policyContext('mcp__db__select', {}, { readOnlyHint: true });
      expect(
        new AskModeReadOnlyMcpApprovePermissionPolicy(askAgent(mode)).evaluate(context),
      ).toBeUndefined();
    }
  });

  it('denies MCP tools that are not declared read-only', () => {
    const agent = askAgent('ask');
    for (const annotations of [
      undefined,
      {} as ToolAnnotations,
      { readOnlyHint: false } as ToolAnnotations,
    ]) {
      const result = evaluateAskPolicy(agent, 'mcp__db__query', { sql: 'select 1' }, annotations);
      expect(result?.kind, JSON.stringify(annotations)).toBe('deny');
      if (result?.kind === 'deny') {
        expect(result.message).toContain('MCP');
        expect(result.message).toContain('not declared read-only');
      }
    }
  });

  it('denies an MCP tool that declares itself both read-only and destructive', () => {
    const result = evaluateAskPolicy(askAgent('ask'), 'mcp__fs__rm', {}, {
      readOnlyHint: true,
      destructiveHint: true,
    });
    expect(result?.kind).toBe('deny');
  });

  it('leaves an annotated read-only MCP tool alone outside ask mode', () => {
    for (const mode of ['yolo', 'auto'] as const) {
      expect(
        evaluateAskPolicy(askAgent(mode), 'mcp__db__select', {}, { readOnlyHint: true }),
        mode,
      ).toBeUndefined();
    }
  });

  it('allows read-only and dialogue tools while ask mode is active', () => {
    const agent = askAgent('ask');
    for (const name of [
      'Read',
      'ReadGroup',
      'ReadMediaFile',
      'Glob',
      'Grep',
      'LSP',
      'WebSearch',
      'FetchURL',
      'AskUserQuestion',
      'TodoList',
      'TaskList',
    ]) {
      expect(evaluateAskPolicy(agent, name, {}), name).toBeUndefined();
    }
  });

  it('is a no-op outside ask mode', () => {
    for (const mode of ['yolo', 'auto'] as const) {
      const agent = askAgent(mode);
      expect(evaluateAskPolicy(agent, 'Bash', {}), mode).toBeUndefined();
      expect(evaluateAskPolicy(agent, 'Write', {}), mode).toBeUndefined();
      expect(evaluateAskPolicy(agent, 'mcp__db__query', {}), mode).toBeUndefined();
      expect(evaluateAskPolicy(agent, 'Read', {}), mode).toBeUndefined();
    }
  });
});
