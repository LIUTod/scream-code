import { createControlledPromise } from '@antfu/utils';
import type { ToolCall } from '@scream-code/ltod';
import { describe, expect, it, vi } from 'vitest';

import type { Agent } from '../../../src/agent';
import { PermissionManager } from '../../../src/agent/permission';
import { CapabilityGuardDenyPermissionPolicy } from '../../../src/agent/permission/policies/capability-guard-deny';
import type { ApprovalResponse, PermissionPolicyContext } from '../../../src/agent/permission/types';
import type { SubagentCapabilityMode } from '../../../src/session/subagent-capability';
import { createFakeJian } from '../../tools/fixtures/fake-jian';

const signal = new AbortController().signal;

function capabilityAgent(mode: SubagentCapabilityMode): Agent {
  return { getCapabilityMode: () => mode } as unknown as Agent;
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
      accesses: [],
      approvalRule: toolName,
      execute: async () => ({ output: '' }),
    },
  } as unknown as PermissionPolicyContext;
}

function evaluate(mode: SubagentCapabilityMode, toolName: string) {
  return new CapabilityGuardDenyPermissionPolicy(capabilityAgent(mode)).evaluate(
    policyContext(toolName),
  );
}

describe('capability guard permission policy', () => {
  it('denies write, execute and nesting tools for a read-only agent', () => {
    for (const name of [
      'Write',
      'Edit',
      'Bash',
      'python',
      'RunScript',
      'Agent',
      'SendSubagentMessage',
      'WolfPack',
    ]) {
      const result = evaluate('read-only', name);
      expect(result?.kind, name).toBe('deny');
      if (result?.kind === 'deny') {
        expect(result.message, name).toContain('read-only');
        expect(result.message, name).toContain(name);
      }
    }
  });

  it('lets the read-only tool set through', () => {
    for (const name of [
      'Read',
      'Grep',
      'Glob',
      'LSP',
      'WebSearch',
      'FetchURL',
      'TodoList',
      'AskUserQuestion',
      'ReportFinding',
      'ReportArchFinding',
      'CreateGoal',
      'ExitPlanMode',
      'ContactParent',
    ]) {
      expect(evaluate('read-only', name), name).toBeUndefined();
    }
  });

  it('read-write keeps file writes but still denies command execution and nesting', () => {
    expect(evaluate('read-write', 'Write')).toBeUndefined();
    expect(evaluate('read-write', 'Edit')).toBeUndefined();
    expect(evaluate('read-write', 'ImageGenerate')).toBeUndefined();
    for (const name of ['Bash', 'RunScript', 'Agent', 'WolfPack']) {
      expect(evaluate('read-write', name)?.kind, name).toBe('deny');
    }
  });

  it('execute keeps command execution but still denies nesting', () => {
    expect(evaluate('execute', 'Bash')).toBeUndefined();
    expect(evaluate('execute', 'python')).toBeUndefined();
    expect(evaluate('execute', 'Write')).toBeUndefined();
    for (const name of ['Agent', 'SendSubagentMessage', 'WolfPack']) {
      expect(evaluate('execute', name)?.kind, name).toBe('deny');
    }
  });

  it('fails closed for unclassified and MCP tool names in every restricted mode', () => {
    for (const mode of ['read-only', 'read-write', 'execute'] as const) {
      expect(evaluate(mode, 'FutureToolX')?.kind, mode).toBe('deny');
      expect(evaluate(mode, 'mcp__db__query')?.kind, mode).toBe('deny');
    }
  });

  it('is a no-op for unrestricted agents', () => {
    for (const name of ['Bash', 'Write', 'Agent', 'mcp__db__query', 'FutureToolX']) {
      expect(evaluate('all', name), name).toBeUndefined();
    }
  });
});

interface FakeAgentOptions {
  readonly mode: SubagentCapabilityMode;
  readonly approval?: ApprovalResponse;
  readonly handler?: (request: unknown) => Promise<ApprovalResponse>;
}

/** Minimal Agent surface PermissionManager touches for these cases. */
function makeManager(options: FakeAgentOptions): {
  manager: PermissionManager;
  requestApproval: ReturnType<typeof vi.fn>;
} {
  const requestApproval = vi.fn(
    options.handler ??
      (async () => options.approval ?? ({ decision: 'approved' } satisfies ApprovalResponse)),
  );
  const agent = {
    agentId: 'agent-7',
    type: 'sub',
    config: { cwd: '/workspace', profileName: 'explore' },
    jian: createFakeJian(),
    emitStatusUpdated: vi.fn(),
    records: { logRecord: vi.fn() },
    replayBuilder: { push: vi.fn() },
    rpc: { requestApproval },
    log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
    planMode: {
      get isActive() {
        return false;
      },
      get planFilePath() {
        return null;
      },
      data: vi.fn(async () => null),
      exit: vi.fn(),
    },
    wolfpackMode: { isActive: false },
    getCapabilityMode: () => options.mode,
  } as unknown as Agent;
  const manager = new PermissionManager(agent);
  Object.assign(agent, { permission: manager });
  return { manager, requestApproval };
}

function toolContext(toolName: string, args: unknown): PermissionPolicyContext {
  return policyContext(toolName, args);
}

describe('capability guard through the permission chain', () => {
  it('blocks a read-only agent before any approval prompt is raised', async () => {
    const { manager, requestApproval } = makeManager({ mode: 'read-only' });

    const result = await manager.beforeToolCall(
      toolContext('Bash', { command: 'rm -rf build', timeout: 60 }),
    );

    expect(result?.block).toBe(true);
    expect(result?.reason).toContain('read-only');
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it("stamps the asking child's capability mode onto the approval request", async () => {
    const answer = createControlledPromise<ApprovalResponse>();
    const { manager, requestApproval } = makeManager({ mode: 'read-only', handler: () => answer });
    // LSP is part of the read-only set and not auto-approved: the request
    // reaching the approval handler is exactly the window the banner sees.
    const pending = manager.beforeToolCall(
      toolContext('LSP', { operation: 'symbols', query: 'PermissionManager' }),
    );

    await vi.waitFor(() => {
      expect(requestApproval).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: 'LSP',
          sourceAgentId: 'agent-7',
          sourceAgentName: 'explore',
          sourceToolName: 'LSP',
          sourceCapabilityMode: 'read-only',
        }),
        expect.any(Object),
      );
    });

    answer.resolve({ decision: 'approved' });
    await expect(pending).resolves.toBeUndefined();
  });
});
