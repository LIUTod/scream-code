/**
 * Revoking a memorized approve-for-session grant: the revocation must land on
 * the wire, and a resumed session must not resurrect the grant.
 */

import { describe, expect, it, vi } from 'vitest';

import { InMemoryAgentRecordPersistence } from '../../../src/agent/records/persistence';
import type { AgentRecord } from '../../../src/agent/records/types';
import { WarningsAskPermissionPolicy } from '../../../src/agent/permission/policies/warnings-ask';
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
    // A literal command grant stands in for a memorized approval: the
    // dangerous-command warning honors it, so "silenced?" is observable.
    first.agent.permission.recordApprovalResult({
      turnId: 0,
      toolCallId: 'call_grant_1',
      toolName: 'Bash',
      action: 'run command',
      sessionApprovalRule: 'Bash(rm -rf /tmp/cache)',
      result: {
        decision: 'approved',
        scope: 'session',
        selectedLabel: 'Approve for this session',
      },
    });

    expect(first.agent.permission.revokeSessionGrant('Bash(rm -rf /tmp/cache)')).toBe(true);
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

    // And the revoked pattern silences nothing any more: the dangerous-command
    // warning (which honors session grants) asks again.
    const verdict = new WarningsAskPermissionPolicy(resumed.agent).evaluate(
      bashContext('rm -rf /tmp/cache'),
    );
    expect(verdict).toMatchObject({ kind: 'ask' });
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
