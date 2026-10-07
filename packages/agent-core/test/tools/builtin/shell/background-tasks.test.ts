import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createBackgroundTask,
  drainCompletedBackgroundTasks,
  getPendingBackgroundCount,
  stopAllPendingBackgroundTasks,
} from '../../../../src/tools/builtin/shell/background-tasks';

/** A completion promise that never settles — keeps the entry "running". */
function neverCompletes(): Promise<{ exitCode: number; output: string }> {
  return new Promise(() => {});
}

function deferredCompletion(): {
  promise: Promise<{ exitCode: number; output: string }>;
  resolve: (value: { exitCode: number; output: string }) => void;
} {
  let resolve!: (value: { exitCode: number; output: string }) => void;
  const promise = new Promise<{ exitCode: number; output: string }>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeEach(() => {
  stopAllPendingBackgroundTasks();
});

describe('createBackgroundTask capacity eviction', () => {
  it('kills the oldest task on eviction and keeps size at MAX_PENDING', () => {
    const kills: Array<ReturnType<typeof vi.fn>> = [];

    for (let i = 0; i < 11; i++) {
      const kill = vi.fn(async () => {});
      kills.push(kill);
      createBackgroundTask(`cmd-${String(i)}`, neverCompletes(), { kill, pid: 1000 + i });
    }

    // The oldest (cmd-0) was evicted to make room for the 11th.
    expect(kills[0]).toHaveBeenCalledTimes(1);
    expect(getPendingBackgroundCount()).toBe(10);

    // Grow to 22 total: 11 more inserts → 11 more evictions → 12 kills total.
    for (let i = 11; i < 22; i++) {
      const kill = vi.fn(async () => {});
      kills.push(kill);
      createBackgroundTask(`cmd-${String(i)}`, neverCompletes(), { kill, pid: 1000 + i });
    }

    const totalKills = kills.reduce((sum, k) => sum + k.mock.calls.length, 0);
    expect(totalKills).toBe(12);
    expect(getPendingBackgroundCount()).toBe(10);

    // Evicted ones are exactly the first 12; survivors were never killed.
    for (let i = 0; i < 12; i++) expect(kills[i]).toHaveBeenCalledTimes(1);
    for (let i = 12; i < 22; i++) expect(kills[i]).not.toHaveBeenCalled();
  });
});

describe('stopAllPendingBackgroundTasks', () => {
  it('kills every pending task and clears the registry', () => {
    const kills = [vi.fn(async () => {}), vi.fn(async () => {}), vi.fn(async () => {})];
    for (const [i, kill] of kills.entries()) {
      createBackgroundTask(`cmd-${String(i)}`, neverCompletes(), { kill, pid: 2000 + i });
    }
    expect(getPendingBackgroundCount()).toBe(3);

    stopAllPendingBackgroundTasks();

    for (const kill of kills) expect(kill).toHaveBeenCalledTimes(1);
    expect(getPendingBackgroundCount()).toBe(0);
    expect(drainCompletedBackgroundTasks()).toEqual([]);
  });
});

describe('drainCompletedBackgroundTasks', () => {
  it('returns a finished task once and does not kill it', async () => {
    const kill = vi.fn(async () => {});
    const { promise, resolve } = deferredCompletion();
    const id = createBackgroundTask('long-build', promise, { kill, pid: 42 });

    resolve({ exitCode: 0, output: 'done' });
    await promise;
    // Let the internal .then that stores `result` run.
    await Promise.resolve();
    await Promise.resolve();

    const drained = drainCompletedBackgroundTasks();
    expect(drained).toHaveLength(1);
    expect(drained[0]).toMatchObject({ id, command: 'long-build', exitCode: 0, output: 'done' });
    expect(getPendingBackgroundCount()).toBe(0);
    expect(kill).not.toHaveBeenCalled();

    // Second drain is empty — the entry is gone.
    expect(drainCompletedBackgroundTasks()).toEqual([]);
  });

  it('keeps unfinished tasks in the registry', () => {
    const kill = vi.fn(async () => {});
    createBackgroundTask('still-running', neverCompletes(), { kill });

    expect(drainCompletedBackgroundTasks()).toEqual([]);
    expect(getPendingBackgroundCount()).toBe(1);
    expect(kill).not.toHaveBeenCalled();
  });
});
