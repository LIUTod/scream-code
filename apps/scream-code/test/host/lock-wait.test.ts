import type { BusyProcessLock, HeldProcessLock } from '@scream-code/scream-code-sdk';
import { describe, expect, it, vi } from 'vitest';

import { waitForTheLock } from '#/host/run';

const busy = (service: boolean): BusyProcessLock =>
  ({ held: false, holder: { pid: 42, startedAt: 1, info: { service } } }) as unknown as BusyProcessLock;
const held = { held: true } as unknown as HeldProcessLock;

describe('a service host behind a terminal host', () => {
  it('waits in place and takes the lock once the terminal host leaves', async () => {
    const claim = vi.fn().mockResolvedValueOnce(busy(false)).mockResolvedValueOnce(busy(false)).mockResolvedValueOnce(held);
    const lock = await waitForTheLock({ kind: 'host' }, { claim, stopRequestedSince: () => false, pollMs: 1 });
    expect(lock).toBe(held);
    expect(claim).toHaveBeenCalledTimes(3);
  });

  it('gives up when a stop was asked for meanwhile, so the background stays stopped', async () => {
    const claim = vi.fn().mockResolvedValue(held);
    expect(await waitForTheLock({ kind: 'host' }, { claim, stopRequestedSince: () => true, pollMs: 1 })).toBeUndefined();
    expect(claim).not.toHaveBeenCalled();
  });

  it("gives up when the lock turns out to be the service's own host", async () => {
    const claim = vi.fn().mockResolvedValue(busy(true));
    expect(await waitForTheLock({ kind: 'host' }, { claim, stopRequestedSince: () => false, pollMs: 1 })).toBeUndefined();
    expect(claim).toHaveBeenCalledTimes(1);
  });
});
