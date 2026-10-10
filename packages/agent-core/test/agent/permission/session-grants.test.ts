import { describe, expect, it } from 'vitest';

import { PermissionManager } from '../../../src/agent/permission';
import { bashContext, grantBashForSession, makePermissionHarness } from './fixtures/manager-harness';

describe('revokeSessionGrant', () => {
  it('drops the memorized pattern so the next call asks again', async () => {
    const { manager, requestApproval } = makePermissionHarness();
    grantBashForSession(manager);

    // The grant is live: the same call sails through without a prompt.
    await expect(manager.beforeToolCall(bashContext('printf ok'))).resolves.toBeUndefined();
    expect(requestApproval).not.toHaveBeenCalled();

    expect(manager.revokeSessionGrant('Bash')).toBe(true);
    expect(manager.sessionApprovalRulePatterns).toEqual([]);

    // Revoked: the same call now falls through to the approval prompt.
    await manager.beforeToolCall(bashContext('printf ok'));
    expect(requestApproval).toHaveBeenCalledTimes(1);
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
