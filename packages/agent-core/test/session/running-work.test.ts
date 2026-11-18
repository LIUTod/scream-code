import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  clearWorkRunning,
  listRunningWork,
  markWorkHandedOff,
  markWorkRunning,
  readRunningWork,
  removeRunningWork,
} from '../../src/session/running-work';
import { testAgent } from '../agent/harness/agent';

const homes: string[] = [];
function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'running-work-'));
  homes.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('running-work register', () => {
  it('records a running turn and clears it when the turn ends', () => {
    const dir = home();
    markWorkRunning(dir, { sessionId: 'ses-a', workDir: '/w', kind: 'goal' });
    expect(readRunningWork(dir, 'ses-a')).toMatchObject({
      sessionId: 'ses-a',
      workDir: '/w',
      kind: 'goal',
      pid: process.pid,
    });
    clearWorkRunning(dir, 'ses-a');
    expect(readRunningWork(dir, 'ses-a')).toBeUndefined();
  });

  it('keeps a handed-off record through the turn ending, until the host takes it', () => {
    const dir = home();
    markWorkRunning(dir, { sessionId: 'ses-h', workDir: '/w', kind: 'chat' });
    markWorkHandedOff(dir, { sessionId: 'ses-h', workDir: '/w', kind: 'chat' });
    clearWorkRunning(dir, 'ses-h');
    expect(readRunningWork(dir, 'ses-h')).toMatchObject({ handoff: true, kind: 'chat' });

    removeRunningWork(dir, 'ses-h');
    expect(listRunningWork(dir)).toEqual([]);
  });

  it('lists every readable record and skips damaged files', () => {
    const dir = home();
    markWorkRunning(dir, { sessionId: 'ses-1', workDir: '/a', kind: 'bot' });
    markWorkRunning(dir, { sessionId: 'ses/2', workDir: '/b', kind: 'chat' });
    const ids = listRunningWork(dir)
      .map((record) => record.sessionId)
      .toSorted();
    expect(ids).toEqual(['ses-1', 'ses/2']);
  });
});

describe('turn tracking', () => {
  it('registers the main agent turn while it runs and removes it after', async () => {
    const dir = home();
    const ctx = testAgent({ sessionId: 'ses-turn', screamHomeDir: dir });
    ctx.configure();
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
    expect(readRunningWork(dir, 'ses-turn')).toMatchObject({ kind: 'chat' });

    await ctx.untilTurnEnd();
    expect(readRunningWork(dir, 'ses-turn')).toBeUndefined();
  });
});
