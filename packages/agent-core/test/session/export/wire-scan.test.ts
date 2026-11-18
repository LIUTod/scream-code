/**
 * The debug export's manifest takes the session's first and last activity
 * from the main agent's wire. Sessions keep that wire at
 * `agents/main/wire.jsonl`; the scan used to read `<sessionDir>/wire.jsonl`
 * only, which real sessions do not have, so both fields were always missing.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { scanSessionWire } from '../../../src/session/export/wire-scan';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function sessionDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wire-scan-'));
  dirs.push(dir);
  return dir;
}

function wire(...times: number[]): string {
  return times.map((time, index) => JSON.stringify({ type: index === 0 ? 'metadata' : 'turn.prompt', time })).join('\n');
}

describe('scanSessionWire', () => {
  it('reads the main agent wire where sessions keep it', async () => {
    const dir = await sessionDir();
    await mkdir(join(dir, 'agents', 'main'), { recursive: true });
    await writeFile(join(dir, 'agents', 'main', 'wire.jsonl'), `${wire(1_700_000_000_000, 1_700_000_100_000)}\n`);
    expect(await scanSessionWire(dir)).toEqual({
      firstActivityMs: 1_700_000_000_000,
      lastActivityMs: 1_700_000_100_000,
    });
  });

  it('falls back to a session-level wire', async () => {
    const dir = await sessionDir();
    await writeFile(join(dir, 'wire.jsonl'), wire(1_700_000_000_000, 1_700_000_050_000));
    expect(await scanSessionWire(dir)).toEqual({
      firstActivityMs: 1_700_000_000_000,
      lastActivityMs: 1_700_000_050_000,
    });
  });

  it('is empty when the session has no wire', async () => {
    expect(await scanSessionWire(await sessionDir())).toEqual({});
  });
});
