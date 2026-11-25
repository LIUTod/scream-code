import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ScreamError } from '@scream-code/scream-code-sdk';
import { afterEach, describe, expect, it } from 'vitest';

import { classifyCheckError, describeHostCheck, readHostCheck, writeHostCheck } from '#/host/check';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('classifyCheckError', () => {
  it('names a missing key, a rejected key and a provider that cannot be reached', () => {
    expect(
      classifyCheckError(
        new Error('OpenAIResponsesChatProvider: apiKey is required. Provide it via the constructor options, ...'),
      ).problem,
    ).toBe('no_key');
    expect(classifyCheckError(new ScreamError('provider.auth_error', 'Invalid API key')).problem).toBe('auth');
    expect(classifyCheckError(new ScreamError('provider.timeout', 'Request timed out.')).problem).toBe('unreachable');
    expect(classifyCheckError(new ScreamError('provider.connection_error', 'ECONNREFUSED')).problem).toBe('unreachable');
    expect(classifyCheckError(new Error('something else')).problem).toBe('failed');
  });
});

describe('host check record', () => {
  it('round-trips, and a missing or broken file reads as none', () => {
    const home = mkdtempSync(join(tmpdir(), 'host-check-'));
    dirs.push(home);
    expect(readHostCheck(home)).toBeUndefined();
    const result = { ok: false, at: 5, version: '0.21.3', problem: 'no_key' as const, launcher: 'abc' };
    writeHostCheck(result, home);
    expect(readHostCheck(home)).toEqual(result);
  });

  it('says what to do when it failed', () => {
    expect(describeHostCheck({ ok: false, at: 1, version: 'v', problem: 'no_key' })).toContain('/config');
    expect(describeHostCheck({ ok: true, at: 1, version: 'v', model: 'm1' })).toContain('m1');
  });
});
