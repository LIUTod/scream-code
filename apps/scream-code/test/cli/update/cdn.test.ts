import { describe, expect, it, vi } from 'vitest';

import { fetchLatestVersionFromCdn } from '#/cli/update/cdn';
import { SCREAM_CODE_CDN_LATEST_URL } from '#/constant/app';

function mockFetchOk(tagName: string): typeof fetch {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ tag_name: tagName }),
  })) as unknown as typeof fetch;
}

function mockFetchStatus(status: number): typeof fetch {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({}),
  })) as unknown as typeof fetch;
}

describe('fetchLatestVersionFromCdn', () => {
  it('returns the tag_name from GitHub Releases API', async () => {
    const f = mockFetchOk('v0.5.0');
    await expect(fetchLatestVersionFromCdn(f)).resolves.toBe('0.5.0');
    expect(f).toHaveBeenCalledWith(SCREAM_CODE_CDN_LATEST_URL);
  });

  it('strips leading v from tag_name', async () => {
    const f = mockFetchOk('v1.2.3');
    await expect(fetchLatestVersionFromCdn(f)).resolves.toBe('1.2.3');
  });

  it('throws when response is non-2xx', async () => {
    await expect(fetchLatestVersionFromCdn(mockFetchStatus(404))).rejects.toThrow(/HTTP 404/);
  });

  it('throws when tag_name is not valid semver', async () => {
    const f = mockFetchOk('not-a-version');
    await expect(fetchLatestVersionFromCdn(f)).rejects.toThrow(/semver/);
  });

  it('throws when tag_name is missing', async () => {
    const f = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
    })) as unknown as typeof fetch;
    await expect(fetchLatestVersionFromCdn(f)).rejects.toThrow(/semver/);
  });

  it('propagates the underlying fetch error', async () => {
    const f = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    await expect(fetchLatestVersionFromCdn(f)).rejects.toThrow(/network down/);
  });
});
