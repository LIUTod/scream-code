import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { requestProcessLock, type HeldProcessLock } from '@scream-code/scream-code-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  claimHostLock,
  getHostLogFile,
  readHostStatus,
  rotateHostLogIfNeeded,
  stopHost,
  wakeHost,
} from '#/host/control';
import { getLineDir, getLinePidFile } from '#/line/config';
import { getDataDir } from '#/utils/paths';

const created: string[] = [];
const locks: HeldProcessLock[] = [];
let savedHome: string | undefined;

beforeEach(() => {
  savedHome = process.env['SCREAM_CODE_HOME'];
  process.env['SCREAM_CODE_HOME'] = mkdtempSync(join(tmpdir(), 'scream-host-'));
  created.push(process.env['SCREAM_CODE_HOME']);
  mkdirSync(getLineDir(), { recursive: true });
});

afterEach(async () => {
  while (locks.length > 0) await locks.pop()!.release();
  if (savedHome === undefined) delete process.env['SCREAM_CODE_HOME'];
  else process.env['SCREAM_CODE_HOME'] = savedHome;
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function claim(): Promise<HeldProcessLock> {
  const lock = await claimHostLock({ kind: 'host' });
  if (!lock.held) throw new Error('expected to take the host lock');
  locks.push(lock);
  return lock;
}

describe('readHostStatus', () => {
  it('reports not-running when nothing holds the lock and there is no pidfile', async () => {
    expect(await readHostStatus()).toEqual({ running: false });
  });

  it('reports the holder of the host lock', async () => {
    await claim();
    expect(await readHostStatus()).toMatchObject({ running: true, pid: process.pid });
  });

  it('removes a legacy pidfile naming a dead pid', async () => {
    writeFileSync(getLinePidFile(), '99999999\n', 'utf-8');
    expect(await readHostStatus()).toEqual({ running: false });
    expect(() => readFileSync(getLinePidFile(), 'utf-8')).toThrow();
  });

  it('removes a corrupt legacy pidfile', async () => {
    writeFileSync(getLinePidFile(), 'not-a-pid', 'utf-8');
    expect(await readHostStatus()).toEqual({ running: false });
    expect(() => readFileSync(getLinePidFile(), 'utf-8')).toThrow();
  });
});

describe('claimHostLock', () => {
  it('lets one host in per Scream home and names the holder to the next', async () => {
    await claim();
    const second = await claimHostLock({ kind: 'host' });
    if (second.held) throw new Error('expected the lock to be busy');
    expect(second.holder?.pid).toBe(process.pid);
  });

  it('clears a legacy pidfile once it holds the lock', async () => {
    writeFileSync(getLinePidFile(), '12345\n', 'utf-8');
    await claim();
    expect(() => readFileSync(getLinePidFile(), 'utf-8')).toThrow();
  });
});

describe('requests to the host', () => {
  it('stop asks the host to stop and returns once the lock is free', async () => {
    const lock = await claim();
    const requests: string[] = [];
    lock.onRequest((request) => {
      requests.push(request.type);
      setImmediate(() => {
        void lock.release();
      });
      return { ok: true };
    });

    expect(await stopHost()).toBe(true);
    expect(requests).toEqual(['stop']);
    expect(await readHostStatus()).toEqual({ running: false });
  });

  it('stop returns false when nothing runs', async () => {
    expect(await stopHost()).toBe(false);
  });

  it('wake reaches the host with the control token', async () => {
    const lock = await claim();
    const requests: string[] = [];
    lock.onRequest((request) => {
      requests.push(request.type);
      return { ok: true };
    });
    expect(await wakeHost()).toBe(true);
    expect(requests).toEqual(['sweep']);
  });

  it('refuses a request without the control token', async () => {
    const lock = await claim();
    let reached = false;
    lock.onRequest(() => {
      reached = true;
      return { ok: true };
    });
    const scope = realpathSync.native(getDataDir());
    const reply = await requestProcessLock({ scope, name: 'host' }, { type: 'stop', token: 'guess' });
    expect(reply).toEqual({ ok: false, error: 'unauthorized' });
    expect(reached).toBe(false);
  });
});

describe('rotateHostLogIfNeeded', () => {
  it('copies a log over the limit to .1 and truncates it in place', async () => {
    mkdirSync(dirname(getHostLogFile()), { recursive: true });
    writeFileSync(getHostLogFile(), 'x'.repeat(2048));
    expect(await rotateHostLogIfNeeded(1024)).toBe(true);
    expect(statSync(getHostLogFile()).size).toBe(0);
    expect(statSync(`${getHostLogFile()}.1`).size).toBe(2048);
  });

  it('leaves a log under the limit alone', async () => {
    mkdirSync(dirname(getHostLogFile()), { recursive: true });
    writeFileSync(getHostLogFile(), 'small');
    expect(await rotateHostLogIfNeeded(1024)).toBe(false);
    expect(readFileSync(getHostLogFile(), 'utf8')).toBe('small');
  });
});
