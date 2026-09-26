import { describe, expect, it } from 'vitest';

import { rmWithRetry } from '../../src/utils/fs';

describe('rmWithRetry', () => {
  function errWith(code: string, message = code): Error {
    return Object.assign(new Error(message), { code });
  }

  it('succeeds without retry when the first rm works', async () => {
    let calls = 0;
    const rmOverride = async () => {
      calls += 1;
    };

    await expect(
      rmWithRetry('/some/dir', { rmOverride }),
    ).resolves.toBeUndefined();
    expect(calls).toBe(1);
  });

  it('retries a transient EBUSY and succeeds on a later attempt', async () => {
    let calls = 0;
    const rmOverride = async () => {
      calls += 1;
      if (calls === 1) throw errWith('EBUSY', 'resource temporarily unavailable');
    };

    await expect(
      rmWithRetry('/some/dir', { rmOverride, backoffMs: [1] }),
    ).resolves.toBeUndefined();
    expect(calls).toBe(2);
  });

  it('gives up after the attempt budget and rethrows the last lock error', async () => {
    let calls = 0;
    const rmOverride = async () => {
      calls += 1;
      throw errWith('EBUSY', 'resource busy');
    };

    await expect(
      rmWithRetry('/some/dir', { rmOverride, backoffMs: [1, 1, 1] }),
    ).rejects.toMatchObject({ code: 'EBUSY' });
    // The attempt budget derives from the custom schedule: 3 backoffs = 4 calls.
    expect(calls).toBe(4);
  });

  it('does not retry codes outside the transient lock set', async () => {
    let calls = 0;
    const rmOverride = async () => {
      calls += 1;
      throw errWith('EFOO', 'not a lock error');
    };

    await expect(
      rmWithRetry('/some/dir', { rmOverride, backoffMs: [1] }),
    ).rejects.toMatchObject({ code: 'EFOO' });
    expect(calls).toBe(1);
  });
});
