import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createBackgroundTask,
  drainCompletedBackgroundTasks,
  getPendingBackgroundCount,
  killAllPendingBackgroundTasks,
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
  killAllPendingBackgroundTasks();
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
  it('sweeps only the named owner and leaves every other task parked', () => {
    const ownKill = vi.fn(async () => {});
    const foreignKill = vi.fn(async () => {});
    const unownedKill = vi.fn(async () => {});
    createBackgroundTask('own-build', neverCompletes(), {
      kill: ownKill,
      pid: 3001,
      ownerId: 'session-a',
    });
    createBackgroundTask('foreign-build', neverCompletes(), {
      kill: foreignKill,
      pid: 3002,
      ownerId: 'session-b',
    });
    createBackgroundTask('no-session', neverCompletes(), { kill: unownedKill, pid: 3003 });

    stopAllPendingBackgroundTasks('session-a');

    // The registry is shared by every session in the process, so closing one
    // session must not execute another session's parked command...
    expect(ownKill).toHaveBeenCalledTimes(1);
    expect(foreignKill).not.toHaveBeenCalled();
    // ...nor a command parked by a caller that had no session to be swept by.
    expect(unownedKill).not.toHaveBeenCalled();
    expect(getPendingBackgroundCount()).toBe(2);
  });

  it('treats a missing owner as its own owner, never as every owner', () => {
    const identifiedKill = vi.fn(async () => {});
    const otherKill = vi.fn(async () => {});
    const ownerlessKill = vi.fn(async () => {});
    createBackgroundTask('identified-build', neverCompletes(), {
      kill: identifiedKill,
      pid: 4001,
      ownerId: 'session-a',
    });
    createBackgroundTask('other-build', neverCompletes(), {
      kill: otherKill,
      pid: 4002,
      ownerId: 'session-b',
    });
    createBackgroundTask('ownerless-build', neverCompletes(), {
      kill: ownerlessKill,
      pid: 4003,
    });

    // A session created without an id (SessionOptions.id is optional) stamps no
    // owner on what its agents park, so its teardown asks for exactly that:
    // the owner-less tasks. Reading the missing id as "everything" would make
    // that close() execute two other sessions' commands.
    stopAllPendingBackgroundTasks(undefined);

    expect(ownerlessKill).toHaveBeenCalledTimes(1);
    expect(identifiedKill).not.toHaveBeenCalled();
    expect(otherKill).not.toHaveBeenCalled();
    expect(getPendingBackgroundCount()).toBe(2);
  });
});

describe('killAllPendingBackgroundTasks', () => {
  it('kills every task regardless of owner (process-wide sweep)', () => {
    const kills = [vi.fn(async () => {}), vi.fn(async () => {}), vi.fn(async () => {})];
    const owners: Array<string | undefined> = ['session-a', 'session-b', undefined];
    for (const [i, kill] of kills.entries()) {
      createBackgroundTask(`cmd-${String(i)}`, neverCompletes(), {
        kill,
        pid: 2000 + i,
        ownerId: owners[i],
      });
    }
    expect(getPendingBackgroundCount()).toBe(3);

    killAllPendingBackgroundTasks();

    // Nothing may outlive the process: the explicit process-wide sweep ignores
    // ownership (including tasks parked with no owner at all).
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
