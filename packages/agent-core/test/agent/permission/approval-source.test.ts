import { createControlledPromise } from '@antfu/utils';
import type { ToolCall } from '@scream-code/ltod';
import { describe, expect, it, vi } from 'vitest';

import type { Agent } from '../../../src/agent';
import { PermissionManager } from '../../../src/agent/permission';
import type { ApprovalResponse } from '../../../src/agent/permission/types';
import type { PermissionPolicyContext } from '../../../src/agent/permission/types';
import type { SubagentCapabilityMode } from '../../../src/session/subagent-capability';
import { createFakeJian } from '../../tools/fixtures/fake-jian';

const signal = new AbortController().signal;

interface FakeAgentOptions {
  readonly agentId?: string;
  readonly profileName?: string | undefined;
  readonly capabilityMode?: SubagentCapabilityMode | undefined;
  readonly approval?: ApprovalResponse;
  readonly handler?: (request: unknown) => Promise<ApprovalResponse>;
}

/** Minimal Agent surface PermissionManager touches when raising an approval. */
function makeManager(options: FakeAgentOptions = {}): {
  manager: PermissionManager;
  requestApproval: ReturnType<typeof vi.fn>;
} {
  const requestApproval = vi.fn(
    options.handler ??
      (async () => options.approval ?? ({ decision: 'approved' } satisfies ApprovalResponse)),
  );
  const agent = {
    // The approval banner reads these two to attribute the request.
    agentId: options.agentId ?? 'main',
    config: { cwd: '/workspace', profileName: options.profileName },
    type: 'main',
    jian: createFakeJian(),
    emitStatusUpdated: vi.fn(),
    records: { logRecord: vi.fn() },
    replayBuilder: { push: vi.fn() },
    rpc: { requestApproval },
    log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
    getCapabilityMode: () => options.capabilityMode ?? ('all' as const),
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
  } as unknown as Agent;
  const manager = new PermissionManager(agent);
  Object.assign(agent, { permission: manager });
  return { manager, requestApproval };
}

function bashContext(): PermissionPolicyContext {
  const args = { command: 'printf approval-source', timeout: 60 } as const;
  const toolCall: ToolCall = {
    type: 'function',
    id: 'call_bash',
    name: 'Bash',
    arguments: JSON.stringify(args),
  };
  return {
    turnId: '0',
    stepNumber: 1,
    signal,
    llm: {} as never,
    args,
    toolCall,
    execution: {
      description: 'Running: printf approval-source',
      display: { kind: 'command', command: args.command, cwd: '/workspace', language: 'bash' },
      accesses: [],
      approvalRule: 'Bash',
      execute: async () => ({ output: '' }),
    },
  } as unknown as PermissionPolicyContext;
}

describe('approval source attribution', () => {
  it('stamps the asking agent id, profile name and triggering tool onto the request', async () => {
    const { manager, requestApproval } = makeManager({
      agentId: 'agent-7',
      profileName: 'reviewer',
    });

    await expect(manager.beforeToolCall(bashContext())).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'Bash',
        sourceAgentId: 'agent-7',
        sourceAgentName: 'reviewer',
        sourceToolName: 'Bash',
      }),
      expect.any(Object),
    );
    // Unrestricted askers carry no capability field: the payload for the
    // common (main-agent) case is unchanged by the capability extension.
    const [request] = requestApproval.mock.calls[0] as [Record<string, unknown>];
    expect(request).not.toHaveProperty('sourceCapabilityMode');
  });

  it('adds the capability contract when the asker runs in a restricted mode', async () => {
    const { manager, requestApproval } = makeManager({
      agentId: 'agent-9',
      profileName: 'execute-child',
      capabilityMode: 'execute',
    });

    await expect(manager.beforeToolCall(bashContext())).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceAgentId: 'agent-9',
        sourceToolName: 'Bash',
        sourceCapabilityMode: 'execute',
      }),
      expect.any(Object),
    );
  });

  it("attributes the root agent as 'main'", async () => {
    const { manager, requestApproval } = makeManager({ agentId: 'main', profileName: 'agent' });

    await manager.beforeToolCall(bashContext());

    expect(requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({ sourceAgentId: 'main', sourceAgentName: 'agent' }),
      expect.any(Object),
    );
  });

  it('carries attribution on the RPC payload while the request is pending', async () => {
    const answer = createControlledPromise<ApprovalResponse>();
    const { manager, requestApproval } = makeManager({
      agentId: 'agent-3',
      profileName: 'explore',
      handler: () => answer,
    });
    const pending = manager.beforeToolCall(bashContext());

    // The request stays pending until the RPC handler answers: the payload
    // handed to `requestApproval` is the single carrier the TUI/web panels
    // read, and it must keep the attribution while the panel is up.
    await vi.waitFor(() => {
      expect(requestApproval).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceAgentId: 'agent-3',
          sourceAgentName: 'explore',
          sourceToolName: 'Bash',
        }),
        expect.any(Object),
      );
    });
    // The pending inventory has no consumer for attribution — nothing may grow
    // a second copy of the fields there (the RPC payload is the only carrier).
    expect(manager.getPendingApprovals()).toHaveLength(1);
    expect(manager.getPendingApprovals()[0]).not.toHaveProperty('sourceAgentId');
    expect(manager.getPendingApprovals()[0]).not.toHaveProperty('sourceAgentName');

    answer.resolve({ decision: 'approved' });
    await expect(pending).resolves.toBeUndefined();
  });
});
