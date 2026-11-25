import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { HostStatus } from '#/host/control';
import { hostBuildIsOlder, resetStaleBuildForTests, restartStaleBackground, STALE_BUILD_RETRY_MS } from '#/host/stale-build';

beforeEach(() => {
  resetStaleBuildForTests();
});

describe('hostBuildIsOlder', () => {
  it('is true only for an older build, or one that predates the build stamp', () => {
    expect(hostBuildIsOlder('0.21.2', '0.21.3')).toBe(true);
    expect(hostBuildIsOlder(undefined, '0.21.3')).toBe(true);
    expect(hostBuildIsOlder('0.21.3', '0.21.3')).toBe(false);
    // An old terminal still open after the upgrade must not take the background back down.
    expect(hostBuildIsOlder('0.21.4', '0.21.3')).toBe(false);
    expect(hostBuildIsOlder('dev', '0.21.3')).toBe(false);
  });
});

/** A host that runs `version` until asked to restart, then is gone (and back, if a service). */
function fakeHost(options: { version?: string; service?: boolean; busy?: boolean; comesBack?: boolean }) {
  let phase: 'running' | 'gone' | 'back' = 'running';
  const status = vi.fn(async (): Promise<HostStatus> => {
    if (phase === 'running') {
      return { running: true, pid: 1, ...(options.version === undefined ? {} : { version: options.version }), ...(options.service === true ? { service: true } : {}) };
    }
    return phase === 'back' ? { running: true, pid: 2, version: '0.21.3' } : { running: false };
  });
  const restartIfIdle = vi.fn(async () => {
    if (options.busy === true) return { ok: false, busy: true };
    phase = options.comesBack === true ? 'back' : 'gone';
    return { ok: true, ...(options.service === true ? { service: true } : {}) };
  });
  const start = vi.fn(async () => {
    phase = 'back';
  });
  return { status, restartIfIdle, start };
}

const base = { entry: '/usr/lib/node_modules/scream-code/dist/main.mjs', version: '0.21.3', sleep: async () => {} };

describe('restartStaleBackground', () => {
  it('restarts an older, idle background and starts the new one from this terminal', async () => {
    const host = fakeHost({ version: '0.21.2' });
    expect(await restartStaleBackground({ ...base, ...host })).toBe('restarted');
    expect(host.restartIfIdle).toHaveBeenCalledTimes(1);
    expect(host.start).toHaveBeenCalledTimes(1);
  });

  it('lets a service bring its own host back, without starting another', async () => {
    const host = fakeHost({ version: '0.21.2', service: true, comesBack: true });
    expect(await restartStaleBackground({ ...base, ...host, serviceRunsEntry: async () => true })).toBe('restarted');
    expect(host.start).not.toHaveBeenCalled();
  });

  it('leaves a current background alone, and never runs from a checkout', async () => {
    const current = fakeHost({ version: '0.21.3' });
    expect(await restartStaleBackground({ ...base, ...current })).toBe('current');
    const old = fakeHost({ version: '0.21.2' });
    expect(await restartStaleBackground({ ...base, ...old, entry: '/src/scream-code/apps/scream-code/src/main.ts' })).toBe(
      'skipped',
    );
    expect(old.restartIfIdle).not.toHaveBeenCalled();
  });

  it('does not restart a service that runs another scream: it would come back just as old', async () => {
    const host = fakeHost({ version: '0.21.2', service: true });
    expect(await restartStaleBackground({ ...base, ...host, serviceRunsEntry: async () => false })).toBe('skipped');
    expect(host.restartIfIdle).not.toHaveBeenCalled();
  });

  it('restarts a background from before the request the way /update does', async () => {
    const stop = vi.fn(async () => {});
    const start = vi.fn(async () => {});
    const status = vi.fn(async (): Promise<HostStatus> => ({ running: true, pid: 1 }));
    const restartIfIdle = vi.fn(async () => ({ ok: false, unsupported: true }));
    expect(await restartStaleBackground({ ...base, status, restartIfIdle, stop, start })).toBe('restarted');
    expect(stop).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('waits for a busy background, asking again only after a while', async () => {
    let now = 1_000_000;
    const host = fakeHost({ version: '0.21.2', busy: true });
    const deps = { ...base, ...host, now: () => now };
    expect(await restartStaleBackground(deps)).toBe('busy');
    expect(await restartStaleBackground(deps)).toBe('skipped');
    now += STALE_BUILD_RETRY_MS;
    expect(await restartStaleBackground(deps)).toBe('busy');
    expect(host.restartIfIdle).toHaveBeenCalledTimes(2);
  });
});
