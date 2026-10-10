/**
 * Revoking a memorized approve-for-session grant: the revocation must land on
 * the wire, and a resumed session must not resurrect the grant.
 */

import { describe, expect, it, vi } from 'vitest';

import { InMemoryAgentRecordPersistence } from '../../../src/agent/records/persistence';
import type { AgentRecord } from '../../../src/agent/records/types';
import { testAgent } from '../harness/agent';
import { bashContext, grantBashForSession, makePermissionHarness } from './fixtures/manager-harness';

async function wireRecords(persistence: InMemoryAgentRecordPersistence): Promise<AgentRecord[]> {
  const records: AgentRecord[] = [];
  for await (const record of persistence.read()) records.push(record);
  return records;
}

describe('grant revocation records', () => {
  it('writes a revocation record when a grant is dropped', () => {
    const { agent, manager } = makePermissionHarness();
    const record = agent.records.logRecord as unknown as ReturnType<typeof vi.fn>;
    grantBashForSession(manager);
    record.mockClear();

    expect(manager.revokeSessionGrant('Bash')).toBe(true);

    expect(record).toHaveBeenCalledWith({
      type: 'permission.record_grant_revocation',
      pattern: 'Bash',
    });
  });

  it('writes nothing when there was no local grant to drop', () => {
    const { agent, manager } = makePermissionHarness();
    const record = agent.records.logRecord as unknown as ReturnType<typeof vi.fn>;

    expect(manager.revokeSessionGrant('Bash')).toBe(false);

    expect(record).not.toHaveBeenCalled();
  });
});

describe('grant revocation across a resume', () => {
  it('keeps the grant revoked and asks again on the next matching call', async () => {
    const persistence = new InMemoryAgentRecordPersistence();
    const first = testAgent({ persistence });
    grantBashForSession(first.agent.permission);
    // The grant is live before the revocation: the call is approved without a
    // prompt, so it settles straight away.
    await expect(first.agent.permission.beforeToolCall(bashContext('printf ok'))).resolves
      .toBeUndefined();

    expect(first.agent.permission.revokeSessionGrant('Bash')).toBe(true);
    expect(first.agent.permission.sessionApprovalRulePatterns).toEqual([]);

    // The wire carries both the grant and its revocation.
    const wire = await wireRecords(persistence);
    expect(wire.map((entry) => entry.type)).toEqual([
      'metadata',
      'permission.record_approval_result',
      'permission.record_grant_revocation',
    ]);

    // Resume: replaying the wire must end in "no grant", not in the grant the
    // approval-result record re-adds on its way through.
    const resumed = testAgent({ persistence });
    await resumed.agent.records.replay();

    expect(resumed.agent.permission.sessionApprovalRulePatterns).toEqual([]);

    // And the revoked pattern is not silently approved any more: the call
    // reaches the approval prompt instead of sailing through.
    const pending = resumed.agent.permission.beforeToolCall(bashContext('printf ok'));
    const { respond } = await resumed.takeApprovalRequest();
    respond({ decision: 'rejected' });
    await expect(pending).resolves.toMatchObject({ block: true });
  });

  it('replays a grant that was never revoked', async () => {
    const persistence = new InMemoryAgentRecordPersistence();
    const first = testAgent({ persistence });
    grantBashForSession(first.agent.permission);

    const resumed = testAgent({ persistence });
    await resumed.agent.records.replay();

    expect(resumed.agent.permission.sessionApprovalRulePatterns).toEqual(['Bash']);
  });
});
