import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CRASH_WINDOW_MS, hostStartsFile, markHostStartClean, recordHostStart } from '#/host/host-starts';

const dirs: string[] = [];
function file(): string {
  const dir = mkdtempSync(join(tmpdir(), 'host-starts-'));
  dirs.push(dir);
  return hostStartsFile(dir);
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('host start record', () => {
  it('counts the hosts that died before this one within the window', () => {
    const f = file();
    const t0 = 1_000_000;
    expect(recordHostStart(f, { at: t0, pid: 1 })).toBe(0);
    expect(recordHostStart(f, { at: t0 + 10_000, pid: 2 })).toBe(1);
    expect(recordHostStart(f, { at: t0 + 20_000, pid: 3 })).toBe(2);
    expect(recordHostStart(f, { at: t0 + 30_000, pid: 4 })).toBe(3);
  });

  it('does not count hosts that shut down on purpose, or died long ago', () => {
    const f = file();
    const t0 = 1_000_000;
    recordHostStart(f, { at: t0, pid: 1 });
    markHostStartClean(f, 1, t0);
    recordHostStart(f, { at: t0 + 1_000, pid: 2 });
    expect(recordHostStart(f, { at: t0 + 2_000, pid: 3 })).toBe(1);
    expect(recordHostStart(f, { at: t0 + 2_000 + CRASH_WINDOW_MS + 1_000, pid: 4 })).toBe(0);
  });

  it('never throws on an unreadable record', () => {
    expect(recordHostStart('/nonexistent-dir/\0/starts.json', { at: 1, pid: 1 })).toBe(0);
  });
});
