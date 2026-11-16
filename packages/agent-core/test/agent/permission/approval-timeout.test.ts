/**
 * Approval-timeout stop-loss.
 *
 * An approval that times out means the user is away. Two guarantees:
 * - The error the model sees says so and tells it not to retry the call.
 * - A second approval request for the same tool in the same turn is denied
 *   immediately (no second 5-minute stall); a later turn asks normally again.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApprovalResponse, PermissionPolicyContext } from '../../../src/agent/permission/types';

import { makePermissionHarness, toolContext } from './fixtures/manager-harness';

const APPROVAL_TIMEOUT_MS = 300_000;

describe('approval timeout stop-loss', () => {
  // A sensitive read is the surviving prompt path: ask mode lets Read through
  // the read-only guard and the sensitive-file ask raises the approval.
  function readAsk(path: string): PermissionPolicyContext {
    const context = toolContext('Read', { path });
    return {
      ...context,
      execution: {
        ...context.execution,
        accesses: [{ kind: 'file', operation: 'read', path }],
      },
    };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('tells the model the user is away when an approval times out', async () => {
    vi.useFakeTimers();
    const { manager, requestApproval } = makePermissionHarness({
      mode: 'ask',
      handler: () => new Promise(() => {}),
    });

    const pending = manager.beforeToolCall(readAsk('.env'));
    const rejection = expect(pending).rejects.toThrow(/The user is likely away/);
    await vi.advanceTimersByTimeAsync(APPROVAL_TIMEOUT_MS);
    await rejection;

    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it('denies a second request for the same tool in the same turn without asking again', async () => {
    vi.useFakeTimers();
    const { manager, requestApproval } = makePermissionHarness({
      mode: 'ask',
      handler: () => new Promise(() => {}),
    });

    const first = manager.beforeToolCall(readAsk('.env'));
    const rejection = expect(first).rejects.toThrow(/The user is likely away/);
    await vi.advanceTimersByTimeAsync(APPROVAL_TIMEOUT_MS);
    await rejection;

    const second = await manager.beforeToolCall(readAsk('.env.local'));

    expect(second).toMatchObject({ block: true });
    expect((second as { reason: string }).reason).toContain('already timed out earlier in this turn');
    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it('asks again in a later turn', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const { manager, requestApproval } = makePermissionHarness({
      mode: 'ask',
      handler: async (): Promise<ApprovalResponse> => {
        calls += 1;
        if (calls === 1) return new Promise<ApprovalResponse>(() => {});
        return { decision: 'approved' };
      },
    });

    const turnZero = readAsk('.env');
    const first = manager.beforeToolCall(turnZero);
    const rejection = expect(first).rejects.toThrow(/The user is likely away/);
    await vi.advanceTimersByTimeAsync(APPROVAL_TIMEOUT_MS);
    await rejection;

    const turnOne = { ...readAsk('.env.local'), turnId: '1' };
    await expect(manager.beforeToolCall(turnOne)).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(2);
  });
});
