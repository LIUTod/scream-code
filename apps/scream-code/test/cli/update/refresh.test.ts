import { describe, expect, it, vi } from 'vitest';

import { refreshUpdateCache } from '#/cli/update/refresh';

describe('refreshUpdateCache', () => {
  it('writes a fresh cache on successful fetch', async () => {
    const writeCache = vi.fn(async () => {});
    const result = await refreshUpdateCache({
      fetchLatest: async () => '0.5.0',
      writeCache,
      now: () => new Date('2026-05-20T12:34:56.000Z'),
    });

    expect(result).toEqual({
      source: 'cdn',
      checkedAt: '2026-05-20T12:34:56.000Z',
      latest: '0.5.0',
    });
    expect(writeCache).toHaveBeenCalledWith({
      source: 'cdn',
      checkedAt: '2026-05-20T12:34:56.000Z',
      latest: '0.5.0',
    });
  });

  it('propagates fetch errors and skips writeCache so the cache is preserved', async () => {
    const writeCache = vi.fn(async () => {});
    await expect(
      refreshUpdateCache({
        fetchLatest: async () => {
          throw new Error('network down');
        },
        writeCache,
        now: () => new Date(),
      }),
    ).rejects.toThrow(/network down/);

    expect(writeCache).not.toHaveBeenCalled();
  });
});
