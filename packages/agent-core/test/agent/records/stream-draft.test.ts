import { describe, expect, it } from 'vitest';

import {
  AGENT_WIRE_PROTOCOL_VERSION,
  InMemoryAgentRecordPersistence,
  type AgentRecord,
} from '../../../src/agent/records';
import { testAgent } from '../harness/agent';

function seededPersistence(records: AgentRecord[]): InMemoryAgentRecordPersistence {
  return new InMemoryAgentRecordPersistence([
    { type: 'metadata', protocol_version: AGENT_WIRE_PROTOCOL_VERSION, created_at: 1 },
    ...records,
  ]);
}

describe('context.stream_draft restore', () => {
  it('surfaces an uncleared draft as a partial replay record', async () => {
    const persistence = seededPersistence([
      { type: 'turn.prompt', input: [{ type: 'text', text: 'q' }], origin: { kind: 'user' } },
      { type: 'context.stream_draft', turnId: '1', text: 'partial reply', think: 'thoughts' },
    ]);
    const { agent } = testAgent({ persistence });

    await agent.records.replay();

    const partial = agent.replayBuilder.buildResult().find((record) => record.type === 'stream_draft_partial');
    expect(partial).toMatchObject({ type: 'stream_draft_partial', turnId: '1', text: 'partial reply', think: 'thoughts' });
  });

  it('replaces earlier draft snapshots with the latest one', async () => {
    const persistence = seededPersistence([
      { type: 'turn.prompt', input: [{ type: 'text', text: 'q' }], origin: { kind: 'user' } },
      { type: 'context.stream_draft', turnId: '1', text: 'first', think: '' },
      { type: 'context.stream_draft', turnId: '1', text: 'first + second', think: '' },
    ]);
    const { agent } = testAgent({ persistence });

    await agent.records.replay();

    const partials = agent.replayBuilder.buildResult().filter((record) => record.type === 'stream_draft_partial');
    expect(partials).toHaveLength(1);
    expect(partials[0]).toMatchObject({ text: 'first + second' });
  });

  it('removes the partial record once the draft is cleared (turn completed)', async () => {
    const persistence = seededPersistence([
      { type: 'turn.prompt', input: [{ type: 'text', text: 'q' }], origin: { kind: 'user' } },
      { type: 'context.stream_draft', turnId: '1', text: 'in flight', think: '' },
      { type: 'context.stream_draft', turnId: '1', text: '', think: '' },
    ]);
    const { agent } = testAgent({ persistence });

    await agent.records.replay();

    const partials = agent.replayBuilder.buildResult().filter((record) => record.type === 'stream_draft_partial');
    expect(partials).toHaveLength(0);
  });

  it('keeps drafts of different turns separate', async () => {
    const persistence = seededPersistence([
      { type: 'turn.prompt', input: [{ type: 'text', text: 'q1' }], origin: { kind: 'user' } },
      { type: 'context.stream_draft', turnId: '1', text: 'crashed turn', think: '' },
      { type: 'turn.prompt', input: [{ type: 'text', text: 'q2' }], origin: { kind: 'user' } },
      { type: 'context.stream_draft', turnId: '2', text: 'running turn', think: '' },
    ]);
    const { agent } = testAgent({ persistence });

    await agent.records.replay();

    const partials = agent.replayBuilder.buildResult().filter((record) => record.type === 'stream_draft_partial');
    expect(partials).toHaveLength(2);
    expect(partials.map((record) => (record.type === 'stream_draft_partial' ? record.turnId : ''))).toEqual([
      '1',
      '2',
    ]);
  });
});
