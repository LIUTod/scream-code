import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { controlTokenPath, readOrCreateControlToken } from '../../src/utils/control-token';

const dirs: string[] = [];
function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'control-token-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('readOrCreateControlToken', () => {
  it('creates an owner-only token once and returns the same one after', () => {
    const dir = home();
    const token = readOrCreateControlToken(dir);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(readOrCreateControlToken(dir)).toBe(token);
    if (process.platform !== 'win32') {
      expect(statSync(controlTokenPath(dir)).mode & 0o777).toBe(0o600);
    }
  });

  it('replaces a damaged token file', () => {
    const dir = home();
    mkdirSync(join(dir, 'run'), { recursive: true });
    writeFileSync(controlTokenPath(dir), 'garbage');
    const token = readOrCreateControlToken(dir);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(controlTokenPath(dir), 'utf8').trim()).toBe(token);
  });
});
