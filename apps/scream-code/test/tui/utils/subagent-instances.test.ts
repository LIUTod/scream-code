import type { SubagentSpawnedEvent } from '@scream-code/scream-code-sdk';
import { describe, expect, it } from 'vitest';

import type { ToolCallBlockData } from '@/tui/types';
import {
  buildAgentRows,
  buildAncestorChain,
  createSubagentInstanceInfo,
  withSubagentInstanceEnded,
  type SubagentInstanceInfo,
} from '@/tui/utils/subagent-instances';
import type { SubagentSlot } from '@/tui/utils/subagent-slots';

function spawnEvent(overrides: Partial<SubagentSpawnedEvent> = {}): SubagentSpawnedEvent {
  return {
    type: 'subagent.spawned',
    subagentId: 'agent-1',
    subagentName: 'coder',
    parentToolCallId: 'tc-1',
    parentAgentId: 'main',
    description: 'fix the parser',
    runInBackground: false,
    ...overrides,
  };
}

function toolCall(overrides: Partial<ToolCallBlockData> = {}): ToolCallBlockData {
  return { id: 'tc-1', name: 'Agent', args: {}, ...overrides };
}

function instance(overrides: Partial<SubagentInstanceInfo> = {}): SubagentInstanceInfo {
  return {
    agentId: 'agent-1',
    type: 'coder',
    description: 'fix the parser',
    parentAgentId: 'main',
    parentToolCallId: 'tc-1',
    parentToolName: 'Agent',
    parentToolDescription: 'fix the parser',
    spawnedAt: 1000,
    ...overrides,
  };
}

function slot(overrides: Partial<SubagentSlot> = {}): SubagentSlot {
  return {
    type: 'coder',
    status: 'idle',
    agentId: undefined,
    detail: undefined,
    count: 0,
    lastActivityAt: 0,
    ...overrides,
  };
}

function registry(...instances: SubagentInstanceInfo[]): Map<string, SubagentInstanceInfo> {
  return new Map(instances.map((info) => [info.agentId, info]));
}

describe('createSubagentInstanceInfo', () => {
  it('captures the spawn facts and the spawning tool call resolved at spawn time', () => {
    const info = createSubagentInstanceInfo(
      spawnEvent({ subagentName: 'verify' }),
      toolCall({ name: 'Agent', description: 'run the suite', args: {} }),
      42,
    );
    expect(info).toMatchObject({
      agentId: 'agent-1',
      type: 'verify',
      description: 'fix the parser',
      parentAgentId: 'main',
      parentToolCallId: 'tc-1',
      parentToolName: 'Agent',
      parentToolDescription: 'run the suite',
      spawnedAt: 42,
    });
    expect(info.endedAt).toBeUndefined();
  });

  it('falls back to args.description when the call carries no description field', () => {
    const info = createSubagentInstanceInfo(
      spawnEvent(),
      toolCall({ args: { description: 'from args' } }),
    );
    expect(info.parentToolDescription).toBe('from args');
  });

  it('keeps the real parent tool-call id even for WolfPack routing ids', () => {
    // WolfPack children get a synthesized per-subagent routing id as their
    // rendering key; the registry stores the WolfPack call id instead.
    const info = createSubagentInstanceInfo(
      spawnEvent({ subagentId: 'agent-9', parentToolCallId: 'call-wolfpack' }),
      toolCall({ id: 'call-wolfpack', name: 'WolfPack', args: { description: 'parallel fix' } }),
    );
    expect(info.parentToolCallId).toBe('call-wolfpack');
    expect(info.parentToolName).toBe('WolfPack');
    expect(info.parentToolDescription).toBe('parallel fix');
  });

  it('records no parent tool name when the call already left the active set', () => {
    const info = createSubagentInstanceInfo(spawnEvent(), undefined);
    expect(info.parentToolName).toBeUndefined();
    expect(info.parentToolDescription).toBeUndefined();
  });
});

describe('withSubagentInstanceEnded', () => {
  it('stamps the outcome without mutating the original record', () => {
    const open = instance();
    const closed = withSubagentInstanceEnded(open, 'failed', 5000);
    expect(closed.endedAt).toBe(5000);
    expect(closed.outcome).toBe('failed');
    expect(open.endedAt).toBeUndefined();
    expect(open.outcome).toBeUndefined();
  });
});

describe('buildAncestorChain', () => {
  it('lists parent types nearest first, stopping before the main agent', () => {
    const parent = instance({ agentId: 'a1', type: 'researcher', parentAgentId: 'main' });
    const middle = instance({ agentId: 'a2', type: 'verify', parentAgentId: 'a1' });
    const self = instance({ agentId: 'a3', type: 'coder', parentAgentId: 'a2' });
    const chain = buildAncestorChain(self, registry(parent, middle, self));
    expect(chain.names).toEqual(['verify', 'researcher']);
    expect(chain.truncated).toBe(false);
  });

  it('is empty for a direct child of the main agent', () => {
    const chain = buildAncestorChain(instance(), registry());
    expect(chain.names).toEqual([]);
    expect(chain.truncated).toBe(false);
  });

  it('marks the chain truncated when a parent record is missing', () => {
    const orphan = instance({ parentAgentId: 'agent-gone' });
    const chain = buildAncestorChain(orphan, registry());
    expect(chain.names).toEqual([]);
    expect(chain.truncated).toBe(true);
  });

  it('stops on a cyclic parent map instead of looping', () => {
    const a = instance({ agentId: 'a1', type: 'coder', parentAgentId: 'a2' });
    const b = instance({ agentId: 'a2', type: 'verify', parentAgentId: 'a1' });
    const chain = buildAncestorChain(a, registry(a, b));
    expect(chain.truncated).toBe(true);
    expect(chain.names).toEqual(['verify']);
  });
});

describe('buildAgentRows', () => {
  it('maps a live slot to a row carrying status, count, activity and source', () => {
    const rows = buildAgentRows(
      [slot({ status: 'working', agentId: 'agent-1', detail: 'tool: Bash', count: 2, lastActivityAt: 7000 })],
      registry(
        instance({ parentToolName: 'WolfPack', parentToolDescription: 'parallel fix' }),
        instance({ agentId: 'agent-2', spawnedAt: 2000 }),
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      key: 'coder',
      type: 'coder',
      status: 'working',
      live: true,
      count: 2,
      detail: 'tool: Bash',
      lastActivityAt: 7000,
      description: 'fix the parser',
      instanceId: 'agent-1',
      source: { kind: 'tool', name: 'WolfPack', description: 'parallel fix' },
    });
  });

  it('skips slots that were never used in this session', () => {
    const rows = buildAgentRows(
      [slot({ type: 'coder' }), slot({ type: 'reviewer' })],
      registry(),
    );
    expect(rows).toEqual([]);
  });

  it('reports the recorded terminal outcome for an idle slot with history', () => {
    const rows = buildAgentRows(
      [slot({ status: 'idle', count: 0, lastActivityAt: 9000 })],
      registry(withSubagentInstanceEnded(instance(), 'failed', 8000)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('failed');
    expect(rows[0]!.live).toBe(false);
    expect(rows[0]!.instanceId).toBeUndefined();
  });

  it('falls back to the live slot status when the latest record already ended', () => {
    const rows = buildAgentRows(
      [slot({ status: 'outputting', agentId: 'agent-2', count: 1, lastActivityAt: 3000 })],
      registry(
        withSubagentInstanceEnded(instance(), 'completed', 2000),
        instance({ agentId: 'agent-2', spawnedAt: 2500 }),
      ),
    );
    expect(rows[0]!.status).toBe('outputting');
    expect(rows[0]!.live).toBe(true);
  });

  it('attributes an rlm() spawn to RLM derivation without a tool-call row', () => {
    const rows = buildAgentRows(
      [slot({ status: 'working', agentId: 'agent-1', count: 1 })],
      registry(
        instance({
          parentToolCallId: 'rlm_1712345678_ab12cd',
          parentToolName: undefined,
          parentToolDescription: undefined,
          description: 'rlm subagent: parse',
        }),
      ),
    );
    expect(rows[0]!.source).toEqual({ kind: 'rlm', name: undefined, description: 'rlm subagent: parse' });
    expect(rows[0]!.description).toBe('rlm subagent: parse');
  });

  it('attributes a nested spawn to the parent agent and chains the ancestors', () => {
    const parent = instance({
      agentId: 'parent-1',
      type: 'researcher',
      description: 'survey the parser',
      parentAgentId: 'main',
      spawnedAt: 100,
    });
    const child = instance({
      agentId: 'child-1',
      type: 'coder',
      description: 'write tests',
      parentAgentId: 'parent-1',
      parentToolCallId: 'nested-call',
      parentToolName: undefined,
      spawnedAt: 200,
    });
    const rows = buildAgentRows(
      [slot({ status: 'working', agentId: 'child-1', count: 1, lastActivityAt: 300 })],
      registry(parent, child),
    );
    expect(rows[0]!.source).toEqual({
      kind: 'agent',
      name: 'researcher',
      description: 'survey the parser',
    });
    expect(rows[0]!.ancestors).toEqual(['researcher']);
    expect(rows[0]!.chainTruncated).toBe(false);
  });

  it('marks a main-agent spawn without a resolvable call as main-derived', () => {
    const rows = buildAgentRows(
      [slot({ status: 'working', agentId: 'agent-1', count: 1 })],
      registry(instance({ parentToolName: undefined, parentToolDescription: undefined })),
    );
    expect(rows[0]!.source).toEqual({ kind: 'main', name: undefined, description: undefined });
  });

  it('sorts live rows before ended ones and both by recency', () => {
    const rows = buildAgentRows(
      [
        slot({ type: 'coder', status: 'idle', lastActivityAt: 100 }),
        slot({ type: 'verify', status: 'working', agentId: 'v1', count: 1, lastActivityAt: 400 }),
        slot({ type: 'writer', status: 'outputting', agentId: 'w1', count: 1, lastActivityAt: 500 }),
      ],
      registry(
        withSubagentInstanceEnded(instance({ type: 'coder' }), 'completed', 350),
        instance({ agentId: 'v1', type: 'verify', spawnedAt: 300 }),
        instance({ agentId: 'w1', type: 'writer', spawnedAt: 450 }),
      ),
    );
    expect(rows.map((row) => row.type)).toEqual(['writer', 'verify', 'coder']);
    expect(rows.map((row) => row.live)).toEqual([true, true, false]);
  });

  it('synthesizes a row for a type the slot cap evicted (registry-only)', () => {
    // Past MAX_SUBAGENT_SLOTS the slot machine hands out a detached slot and
    // never registers it, so the extra type cannot appear in `slots`; the
    // registry still records every spawn, and the view must not drop it.
    const evicted = withSubagentInstanceEnded(
      instance({
        agentId: 'agent-17',
        type: 'cartographer',
        description: 'map the parser',
        parentToolName: 'Agent',
        parentToolDescription: 'map the parser',
        spawnedAt: 1000,
      }),
      'completed',
      2000,
    );
    const rows = buildAgentRows(
      [slot({ status: 'working', agentId: 'agent-1', count: 1, lastActivityAt: 500 })],
      registry(instance({ agentId: 'agent-1', spawnedAt: 400 }), evicted),
    );

    expect(rows).toHaveLength(2);
    // Existing ordering rule still holds: the live row comes first.
    expect(rows.map((row) => row.type)).toEqual(['coder', 'cartographer']);
    expect(rows[1]).toMatchObject({
      key: 'cartographer',
      type: 'cartographer',
      status: 'completed',
      live: false,
      count: 1,
      lastActivityAt: 2000,
      description: 'map the parser',
      instanceId: undefined,
      source: { kind: 'tool', name: 'Agent', description: 'map the parser' },
      ancestors: [],
      chainTruncated: false,
    });
    expect(rows[1]!.detail).toBeUndefined();
  });

  it('aggregates a registry-only type: latest outcome, instance count, latest end time', () => {
    const earlier = withSubagentInstanceEnded(
      instance({ agentId: 'agent-17', type: 'cartographer', spawnedAt: 1000 }),
      'completed',
      1500,
    );
    const later = withSubagentInstanceEnded(
      instance({ agentId: 'agent-18', type: 'cartographer', spawnedAt: 3000 }),
      'failed',
      4000,
    );
    const scribe = withSubagentInstanceEnded(
      instance({ agentId: 'agent-19', type: 'scribe', spawnedAt: 2000 }),
      'completed',
      2500,
    );
    const rows = buildAgentRows([], registry(earlier, later, scribe));

    expect(rows.map((row) => row.type)).toEqual(['cartographer', 'scribe']);
    expect(rows[0]).toMatchObject({
      status: 'failed',
      live: false,
      count: 2,
      lastActivityAt: 4000,
      instanceId: undefined,
    });
  });

  it('falls back to idle for a registry-only type whose latest instance has no outcome', () => {
    const rows = buildAgentRows(
      [],
      registry(instance({ agentId: 'agent-17', type: 'cartographer', spawnedAt: 7000 })),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('idle');
    expect(rows[0]!.live).toBe(false);
    expect(rows[0]!.lastActivityAt).toBe(7000);
  });
});
