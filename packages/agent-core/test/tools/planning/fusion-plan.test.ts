import { describe, expect, it, vi } from 'vitest';

import type { SessionSubagentHost } from '../../../src/session/subagent-host';
import { FusionPlanTool } from '../../../src/tools/builtin/planning/fusion-plan';
import { executeTool } from '../fixtures/execute-tool';

const signal = new AbortController().signal;

function context(args: Record<string, unknown>, toolCallId = 'call_fusion') {
  return { turnId: '0', toolCallId, args, signal };
}

function mockSubagentHost<T extends Pick<SessionSubagentHost, 'spawn'> & Partial<SessionSubagentHost>>(
  host: T,
): T & SessionSubagentHost {
  return { resume: vi.fn(), ...host } as unknown as T & SessionSubagentHost;
}

function mockAgent(overrides: {
  subagentHost?: SessionSubagentHost;
  planMode?: {
    isActive?: boolean;
    planFilePath?: string | null;
    enter?: () => Promise<void>;
    setStrategy?: () => void;
    createPlanId?: () => string;
  };
  jian?: { writeText: () => Promise<void> };
  type?: 'main' | 'sub';
}): unknown {
  return {
    type: overrides.type ?? 'main',
    subagentHost: overrides.subagentHost,
    planMode: {
      isActive: overrides.planMode?.isActive ?? false,
      planFilePath: overrides.planMode?.planFilePath ?? '/plans/test.md',
      enter: overrides.planMode?.enter ?? vi.fn().mockResolvedValue(undefined),
      setStrategy: overrides.planMode?.setStrategy ?? vi.fn(),
      createPlanId: overrides.planMode?.createPlanId ?? vi.fn().mockReturnValue('test-plan'),
    },
    jian: {
      writeText: overrides.jian?.writeText ?? vi.fn().mockResolvedValue(undefined),
    },
  };
}

describe('FusionPlanTool', () => {
  it('spawns the default 3 plan subagents and synthesizes their outputs', async () => {
    const spawn = vi
      .fn()
      .mockResolvedValueOnce({
        agentId: 'plan-1',
        profileName: 'plan',
        resumed: false,
        completion: Promise.resolve({ result: 'Plan from angle 1' }),
      })
      .mockResolvedValueOnce({
        agentId: 'plan-2',
        profileName: 'plan',
        resumed: false,
        completion: Promise.resolve({ result: 'Plan from angle 2' }),
      })
      .mockResolvedValueOnce({
        agentId: 'plan-3',
        profileName: 'plan',
        resumed: false,
        completion: Promise.resolve({ result: 'Plan from angle 3' }),
      })
      .mockResolvedValueOnce({
        agentId: 'synthesis',
        profileName: 'plan',
        resumed: false,
        completion: Promise.resolve({ result: 'Synthesized plan' }),
      });
    const host = mockSubagentHost({ spawn });
    const agent = mockAgent({ subagentHost: host });
    const tool = new FusionPlanTool(agent as never);

    const result = await executeTool(tool, context({ task: 'Refactor auth' }));

    expect(spawn).toHaveBeenCalledTimes(4);
    expect(spawn).toHaveBeenNthCalledWith(
      1,
      'plan',
      expect.objectContaining({ description: 'Plan angle: 最佳正确性' }),
    );
    expect(spawn).toHaveBeenNthCalledWith(
      2,
      'plan',
      expect.objectContaining({ description: 'Plan angle: 最小侵入性' }),
    );
    expect(spawn).toHaveBeenNthCalledWith(
      3,
      'plan',
      expect.objectContaining({ description: 'Plan angle: 最优架构性' }),
    );
    expect(spawn).toHaveBeenNthCalledWith(
      4,
      'plan',
      expect.objectContaining({ description: 'Synthesize plans' }),
    );
    expect(result.isError).toBe(false);
    expect(result.output).toContain('Synthesized plan');
  });

  it('returns an error when all workers fail', async () => {
    const spawn = vi.fn().mockResolvedValue({
      agentId: 'plan-1',
      profileName: 'plan',
      resumed: false,
      completion: Promise.reject(new Error('worker failed')),
    });
    const host = mockSubagentHost({ spawn });
    const agent = mockAgent({ subagentHost: host });
    const tool = new FusionPlanTool(agent as never);

    const result = await executeTool(tool, context({ task: 'Refactor auth', worker_count: 1 }));

    expect(result.isError).toBe(true);
    expect(result.output).toContain('All fusion plan workers failed');
  });

  it('rejects invocation from subagents', async () => {
    const agent = mockAgent({ type: 'sub' });
    const tool = new FusionPlanTool(agent as never);

    const result = await executeTool(tool, context({ task: 'Refactor auth' }));

    expect(result.isError).toBe(true);
    expect(result.output).toContain('only be invoked by the main agent');
  });
});
