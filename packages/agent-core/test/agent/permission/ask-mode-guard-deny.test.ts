import type { ToolCall } from '@scream-code/ltod';
import { describe, expect, it } from 'vitest';

import type { Agent } from '../../../src/agent';
import type { PermissionMode, PermissionPolicyContext } from '../../../src/agent/permission';
import { AskModeGuardDenyPermissionPolicy } from '../../../src/agent/permission/policies/ask-mode-guard-deny';

const signal = new AbortController().signal;

function askAgent(mode: PermissionMode = 'ask'): Agent {
  return { permission: { mode } } as unknown as Agent;
}

function policyContext(toolName: string, args: unknown): PermissionPolicyContext {
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
  } as PermissionPolicyContext;
}

function evaluateAskPolicy(agent: Agent, toolName: string, args: unknown) {
  return new AskModeGuardDenyPermissionPolicy(agent).evaluate(policyContext(toolName, args));
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

  it('denies MCP tools while ask mode is active', () => {
    const result = evaluateAskPolicy(askAgent('ask'), 'mcp__db__query', { sql: 'select 1' });
    expect(result?.kind).toBe('deny');
    if (result?.kind === 'deny') {
      expect(result.message).toContain('MCP');
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
    for (const mode of ['manual', 'yolo', 'auto'] as const) {
      const agent = askAgent(mode);
      expect(evaluateAskPolicy(agent, 'Bash', {}), mode).toBeUndefined();
      expect(evaluateAskPolicy(agent, 'Write', {}), mode).toBeUndefined();
      expect(evaluateAskPolicy(agent, 'mcp__db__query', {}), mode).toBeUndefined();
      expect(evaluateAskPolicy(agent, 'Read', {}), mode).toBeUndefined();
    }
  });
});
