import { describe, expect, it } from 'vitest';

import { PermissionManager } from '../../../src/agent/permission';
import { WarningsAskPermissionPolicy } from '../../../src/agent/permission/policies/warnings-ask';
import { bashContext, grantBashForSession, makePermissionHarness } from './fixtures/manager-harness';

describe('revokeSessionGrant', () => {
  it('drops the memorized pattern so the next call asks again', () => {
    const { agent, manager } = makePermissionHarness();
    manager.recordApprovalResult({
      turnId: 0,
      toolCallId: 'call_danger_1',
      toolName: 'Bash',
      action: 'run command',
      sessionApprovalRule: 'Bash(rm -rf /tmp/cache)',
      result: {
        decision: 'approved',
        scope: 'session',
        selectedLabel: 'Approve for this session',
      },
    });
    // The dangerous-command warning honors the exact-command grant, so it is
    // the surviving probe for "is this pattern silenced?".
    const policy = () =>
      new WarningsAskPermissionPolicy(agent).evaluate(bashContext('rm -rf /tmp/cache'));

    // The grant is live: the call sails through without a prompt.
    expect(policy()).toBeUndefined();

    expect(manager.revokeSessionGrant('Bash(rm -rf /tmp/cache)')).toBe(true);
    expect(manager.sessionApprovalRulePatterns).toEqual([]);

    // Revoked: the call falls through to the approval prompt again.
    expect(policy()).toMatchObject({ kind: 'ask' });
  });

  it('returns false for a pattern that was never granted', () => {
    const { manager } = makePermissionHarness();

    expect(manager.revokeSessionGrant('Bash(rm *)')).toBe(false);
  });

  it('cannot revoke a grant held by the parent chain', () => {
    const parent = makePermissionHarness();
    grantBashForSession(parent.manager);
    const child = makePermissionHarness();
    const childManager = new PermissionManager(child.agent, { parent: parent.manager });
    expect(childManager.sessionApprovalRulePatterns).toContain('Bash');

    expect(childManager.revokeSessionGrant('Bash')).toBe(false);

    // Revocation is local only: the parent still holds its grant.
    expect(parent.manager.sessionApprovalRulePatterns).toContain('Bash');
    expect(childManager.sessionApprovalRulePatterns).toContain('Bash');
  });
});
