import { describe, expect, it, vi } from 'vitest';

import { fetchLatestVersionFromCdn } from '#/cli/update/cdn';
import { SCREAM_CODE_CDN_LATEST_URL } from '#/constant/app';

function mockFetchOk(body: string): typeof fetch {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    text: async () => body,
  })) as unknown as typeof fetch;
}

function mockFetchStatus(status: number): typeof fetch {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => '',
  })) as unknown as typeof fetch;
}

describe('fetchLatestVersionFromCdn', () => {
  it('returns the trimmed semver returned by CDN /latest', async () => {
    const f = mockFetchOk('  0.5.0\n');
    await expect(fetchLatestVersionFromCdn(f)).resolves.toBe('0.5.0');
    expect(f).toHaveBeenCalledWith(SCREAM_CODE_CDN_LATEST_URL);
  });

  it('throws when response is non-2xx', async () => {
    await expect(fetchLatestVersionFromCdn(mockFetchStatus(404))).rejects.toThrow(/HTTP 404/);
  });

  it('throws when body is not valid semver', async () => {
    await expect(fetchLatestVersionFromCdn(mockFetchOk('not-a-version'))).rejects.toThrow(
      /invalid semver/,
    );
  });

  it('throws when body is empty', async () => {
    await expect(fetchLatestVersionFromCdn(mockFetchOk('   '))).rejects.toThrow(/invalid semver/);
  });

  it('propagates the underlying fetch error', async () => {
    const f = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    await expect(fetchLatestVersionFromCdn(f)).rejects.toThrow(/network down/);
  });
});
