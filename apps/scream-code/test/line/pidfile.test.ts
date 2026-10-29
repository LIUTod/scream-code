import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getLineDir, getLinePidFile } from '#/line/config';
import { readLineDaemonStatus, stopLineDaemon } from '#/line/pidfile';

const created: string[] = [];
let savedHome: string | undefined;

beforeEach(() => {
  savedHome = process.env['SCREAM_CODE_HOME'];
  process.env['SCREAM_CODE_HOME'] = mkdtempSync(join(tmpdir(), 'line-pid-'));
  created.push(process.env['SCREAM_CODE_HOME']);
  mkdirSync(getLineDir(), { recursive: true });
});

afterEach(() => {
  if (savedHome === undefined) delete process.env['SCREAM_CODE_HOME'];
  else process.env['SCREAM_CODE_HOME'] = savedHome;
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('readLineDaemonStatus', () => {
  it('reports not-running when no pidfile exists', async () => {
    const status = await readLineDaemonStatus();
    expect(status.running).toBe(false);
    expect(status.stale).toBeUndefined();
  });

  it('reports running for the current process (a live node pid)', async () => {
    writeFileSync(getLinePidFile(), `${process.pid}\n`, 'utf-8');
    const status = await readLineDaemonStatus();
    expect(status.running).toBe(true);
    expect(status.pid).toBe(process.pid);
  });

  it('reports stale and cleans up a dead pid', async () => {
    // A pid that is virtually never allocated.
    writeFileSync(getLinePidFile(), '99999999\n', 'utf-8');
    const status = await readLineDaemonStatus();
    expect(status.running).toBe(false);
    expect(status.stale).toBe(true);
    // The stale pidfile is removed so the next start is not blocked.
    expect(() => readFileSync(getLinePidFile(), 'utf-8')).toThrow();
  });

  it('reports stale for a malformed pidfile and cleans it up', async () => {
    writeFileSync(getLinePidFile(), 'not-a-pid', 'utf-8');
    const status = await readLineDaemonStatus();
    expect(status.running).toBe(false);
    expect(status.stale).toBe(true);
    expect(() => readFileSync(getLinePidFile(), 'utf-8')).toThrow();
  });
});

describe('stopLineDaemon', () => {
  it('returns false and leaves no pidfile when nothing runs', async () => {
    expect(await stopLineDaemon()).toBe(false);
    expect(() => readFileSync(getLinePidFile(), 'utf-8')).toThrow();
  });

  it('cleans up a stale pidfile instead of killing an unrelated pid', async () => {
    writeFileSync(getLinePidFile(), '99999999\n', 'utf-8');
    expect(await stopLineDaemon()).toBe(false);
    expect(() => readFileSync(getLinePidFile(), 'utf-8')).toThrow();
  });
});
