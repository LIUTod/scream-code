/**
 * `permission.record_decision` — the audit record written when a call is
 * stopped by a policy or when its approval is cancelled or times out.
 */

import { describe, expect, it, vi } from 'vitest';

import type { ApprovalResponse } from '../../../src/agent/permission/types';
import { makePermissionHarness, toolContext } from './fixtures/manager-harness';

function decisionCalls(record: ReturnType<typeof vi.fn>): unknown[] {
  return record.mock.calls
    .map((call) => call[0] as { type?: string })
    .filter((entry) => entry.type === 'permission.record_decision');
}

describe('permission decision records', () => {
  it('records a policy denial with the policy name and reason', async () => {
    const { agent, manager } = makePermissionHarness();
    const record = agent.records.logRecord as unknown as ReturnType<typeof vi.fn>;
    manager.rules.push({ decision: 'deny', scope: 'user', pattern: 'Write' });

    await expect(manager.beforeToolCall(toolContext('Write', { path: '/workspace/a.ts' })))
      .resolves.toMatchObject({ block: true });

    expect(decisionCalls(record)).toEqual([
      expect.objectContaining({
        turnId: 0,
        toolCallId: 'call_write',
        toolName: 'Write',
        policyName: 'user-configured-deny',
        decision: 'deny',
        reason: expect.stringContaining('denied'),
      }),
    ]);
  });

  it('records a cancelled approval', async () => {
    const { agent, manager } = makePermissionHarness({
      handler: () => new Promise<ApprovalResponse>(() => {}),
    });
    const record = agent.records.logRecord as unknown as ReturnType<typeof vi.fn>;

    const pending = manager.beforeToolCall(toolContext('Write', { path: '/workspace/a.ts' }));
    // Settle the rejection now so the assertion below cannot leave it hanging.
    const outcome = pending.then(
      () => 'resolved',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    await vi.waitFor(() => {
      expect(manager.getPendingApprovals()).toHaveLength(1);
    });
    manager.cancelApproval(manager.getPendingApprovals()[0]?.id ?? '');
    await expect(outcome).resolves.toBe('Approval request cancelled');

    expect(decisionCalls(record)).toEqual([
      expect.objectContaining({
        toolName: 'Write',
        decision: 'cancelled',
        reason: 'Approval request cancelled',
      }),
    ]);
    expect(decisionCalls(record)[0]).not.toHaveProperty('policyName');
  });

  it('records a timed-out approval', async () => {
    vi.useFakeTimers();
    try {
      const { agent, manager } = makePermissionHarness({
        handler: () => new Promise<ApprovalResponse>(() => {}),
      });
      const record = agent.records.logRecord as unknown as ReturnType<typeof vi.fn>;

      const pending = manager.beforeToolCall(toolContext('Write', { path: '/workspace/a.ts' }));
      const assertion = expect(pending).rejects.toThrow(
        'Approval request timed out after 300000ms',
      );
      await vi.advanceTimersByTimeAsync(300_000);
      await assertion;

      expect(decisionCalls(record)).toEqual([
        expect.objectContaining({
          toolName: 'Write',
          decision: 'timeout',
          reason: 'Approval request timed out after 300000ms',
        }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('records a cancelled approval when no handler is available', async () => {
    const { agent, manager } = makePermissionHarness();
    const record = agent.records.logRecord as unknown as ReturnType<typeof vi.fn>;
    delete (agent.rpc as { requestApproval?: unknown }).requestApproval;

    await expect(manager.beforeToolCall(toolContext('Write', { path: '/workspace/a.ts' })))
      .resolves.toMatchObject({ block: true });

    expect(decisionCalls(record)).toEqual([
      expect.objectContaining({
        toolName: 'Write',
        decision: 'cancelled',
        reason: 'Approval handler is unavailable.',
      }),
    ]);
  });

  it('writes nothing when the call is approved', async () => {
    const { agent, manager } = makePermissionHarness();
    const record = agent.records.logRecord as unknown as ReturnType<typeof vi.fn>;

    await manager.beforeToolCall(toolContext('Write', { path: '/workspace/a.ts' }));

    expect(decisionCalls(record)).toEqual([]);
  });
});
