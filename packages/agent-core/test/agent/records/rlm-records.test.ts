import { describe, expect, it } from 'vitest';

import {
  AGENT_WIRE_PROTOCOL_VERSION,
  InMemoryAgentRecordPersistence,
  type AgentRecord,
} from '../../../src/agent/records';
import type { AgentStatusUpdatedEvent } from '../../../src/rpc';
import { testAgent } from '../harness/agent';

function metadataRecord(protocolVersion = AGENT_WIRE_PROTOCOL_VERSION): AgentRecord {
  return {
    type: 'metadata',
    protocol_version: protocolVersion,
    created_at: 1,
  };
}

describe('RLM wire records (v1.6)', () => {
  it('restores a main-agent enter payload (maxDepth) and later settings', async () => {
    const persistence = new InMemoryAgentRecordPersistence([
      metadataRecord(),
      { type: 'rlm.enter', maxDepth: 3 },
      { type: 'rlm.settings', maxDepth: 5 },
    ] as readonly AgentRecord[]);
    const { agent } = testAgent({ persistence });

    await agent.records.replay();

    expect(agent.getRlmEnabled()).toBe(true);
    expect(agent.getRlmMaxDepth()).toBe(5);
  });

  it('restores a subagent inherited enter (depth + maxDepth)', async () => {
    const persistence = new InMemoryAgentRecordPersistence([
      metadataRecord(),
      { type: 'rlm.enter', depth: 2, maxDepth: 3 },
    ] as readonly AgentRecord[]);
    const { agent } = testAgent({ persistence });

    await agent.records.replay();

    expect(agent.getRlmEnabled()).toBe(true);
    expect(agent.getRlmDepth()).toBe(2);
    expect(agent.getRlmMaxDepth()).toBe(3);
  });

  it('keeps unlimited defaults when a pre-1.6 enter carries no payload', async () => {
    const persistence = new InMemoryAgentRecordPersistence([
      metadataRecord('1.5'),
      { type: 'rlm.enter' },
    ] as readonly AgentRecord[]);
    const { agent } = testAgent({ persistence });

    await agent.records.replay();

    expect(agent.getRlmEnabled()).toBe(true);
    expect(agent.getRlmDepth()).toBe(0);
    expect(agent.getRlmMaxDepth()).toBe(Infinity);
  });

  it('lets a later unlimited settings record clear an earlier cap', async () => {
    const persistence = new InMemoryAgentRecordPersistence([
      metadataRecord(),
      { type: 'rlm.enter', maxDepth: 3 },
      { type: 'rlm.settings', maxDepth: null },
    ] as readonly AgentRecord[]);
    const { agent } = testAgent({ persistence });

    await agent.records.replay();

    expect(agent.getRlmMaxDepth()).toBe(Infinity);
  });

  it('migrates a v1.5 wire with rlm records and rewrites it as v1.6', async () => {
    const persistence = new InMemoryAgentRecordPersistence([
      metadataRecord('1.5'),
      { type: 'rlm.enter', maxDepth: 2 },
    ] as readonly AgentRecord[]);
    const { agent } = testAgent({ persistence });

    await agent.records.replay();

    expect(agent.getRlmMaxDepth()).toBe(2);
    expect(
      (persistence.records[0] as { readonly protocol_version?: string }).protocol_version,
    ).toBe(AGENT_WIRE_PROTOCOL_VERSION);
  });

  it('writes rlm.settings (and a main status event) on every live change', async () => {
    const persistence = new InMemoryAgentRecordPersistence();
    const ctx = testAgent({ persistence });
    ctx.configure();

    const statuses: AgentStatusUpdatedEvent[] = [];
    ctx.agent.eventBus.subscribe('agent.status.updated', (event) => {
      statuses.push(event as AgentStatusUpdatedEvent);
    });

    // RLM is off here on purpose: the cap is a setting, not a mode, and must
    // persist in any state.
    ctx.agent.setRlmMaxDepth(3);

    await ctx.agent.records.flush();
    const settings = persistence.records.filter((record) => record.type === 'rlm.settings');
    expect(settings).toEqual([expect.objectContaining({ maxDepth: 3 })]);
    expect(statuses.at(-1)).toMatchObject({
      agentId: 'main',
      rlmEnabled: false,
      rlmMaxDepth: 3,
    });

    // 0 normalizes to unlimited, serialized on the wire as null.
    ctx.agent.setRlmMaxDepth(0);
    await ctx.agent.records.flush();
    const afterUnlimited = persistence.records.filter((record) => record.type === 'rlm.settings');
    expect(afterUnlimited.at(-1)).toMatchObject({ maxDepth: null });
    expect(ctx.agent.getRlmMaxDepth()).toBe(Infinity);
    expect(statuses.at(-1)).toMatchObject({ rlmMaxDepth: null });

    // Roundtrip: a fresh agent replaying the persisted records restores the cap.
    const replayed = testAgent({
      persistence: new InMemoryAgentRecordPersistence(
        persistence.records.map((record) => ({ ...record })),
      ),
    });
    await replayed.agent.records.replay();
    expect(replayed.agent.getRlmMaxDepth()).toBe(Infinity);

    ctx.agent.setRlmMaxDepth(7);
    await ctx.agent.records.flush();
    const replayedWithCap = testAgent({
      persistence: new InMemoryAgentRecordPersistence(
        persistence.records.map((record) => ({ ...record })),
      ),
    });
    await replayedWithCap.agent.records.replay();
    expect(replayedWithCap.agent.getRlmMaxDepth()).toBe(7);
  });

  it('stamps the configured agent id on status events', () => {
    const ctx = testAgent({ agentId: 'agent-7' });
    ctx.configure();

    const statuses: AgentStatusUpdatedEvent[] = [];
    ctx.agent.eventBus.subscribe('agent.status.updated', (event) => {
      statuses.push(event as AgentStatusUpdatedEvent);
    });

    ctx.agent.setRlmMaxDepth(2);

    expect(statuses.at(-1)).toMatchObject({ agentId: 'agent-7', rlmMaxDepth: 2 });
  });

  it('inherits the enter payload for a subagent through inheritRlm', async () => {
    const persistence = new InMemoryAgentRecordPersistence();
    const ctx = testAgent({ persistence, agentId: 'agent-3' });
    ctx.agent.setRlmDepth(2);
    ctx.agent.setRlmMaxDepth(4);

    ctx.agent.inheritRlm();
    await ctx.agent.records.flush();

    const enter = persistence.records.find((record) => record.type === 'rlm.enter');
    expect(enter).toMatchObject({ depth: 2, maxDepth: 4 });

    // And the same record restores both fields on replay.
    const replayed = testAgent({
      persistence: new InMemoryAgentRecordPersistence(
        persistence.records.map((record) => ({ ...record })),
      ),
    });
    await replayed.agent.records.replay();
    expect(agentRlmState(replayed.agent)).toEqual({ enabled: true, depth: 2, maxDepth: 4 });
  });
});

function agentRlmState(agent: {
  getRlmEnabled(): boolean;
  getRlmDepth(): number;
  getRlmMaxDepth(): number;
}): { enabled: boolean; depth: number; maxDepth: number } {
  return {
    enabled: agent.getRlmEnabled(),
    depth: agent.getRlmDepth(),
    maxDepth: agent.getRlmMaxDepth(),
  };
}
