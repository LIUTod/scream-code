/**
 * `background.killGracePeriodMs` bounds the SIGTERM→SIGKILL escalation in
 * `BackgroundProcessManager.stop()`: the 5s default exists for processes that
 * close their pipes politely, and a deployment that knows its commands die
 * (or must die) faster can shorten it.
 */

import { Readable, type Writable } from 'node:stream';

import type { JianProcess } from '@scream-code/jian';
import { describe, expect, it, vi } from 'vitest';

import { BackgroundProcessManager } from '../../../src/tools/background/manager';

/** A process that ignores SIGTERM: only the escalation ends it. */
function stubbornProcess(killSpy: ReturnType<typeof vi.fn>): JianProcess {
  return {
    stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
    stdout: Readable.from([]),
    stderr: Readable.from([]),
    pid: 8765,
    exitCode: null,
    wait: vi.fn(() => new Promise<number>(() => {})),
    kill: killSpy as unknown as JianProcess['kill'],
  };
}

describe('BackgroundProcessManager — killGracePeriodMs', () => {
  it('escalates after the configured grace instead of the 5s default', async () => {
    const killSpy = vi.fn(async () => {});
    const manager = new BackgroundProcessManager({ killGracePeriodMs: 0 });
    const taskId = manager.register(stubbornProcess(killSpy), 'sleep 60', 'stubborn');

    const startedAt = Date.now();
    const info = await manager.stop(taskId, 'user stopped it');
    const elapsedMs = Date.now() - startedAt;

    expect(info?.status).toBe('killed');
    expect(info?.stopReason).toBe('user stopped it');
    // With the hardcoded 5s grace this would take ~5s and still report killed,
    // so the time bound is what pins the wiring.
    expect(elapsedMs).toBeLessThan(1_000);
    expect(killSpy).toHaveBeenNthCalledWith(1, 'SIGTERM');
    expect(killSpy).toHaveBeenNthCalledWith(2, 'SIGKILL');
  });
});
