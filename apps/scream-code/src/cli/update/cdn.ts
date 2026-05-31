import { valid } from 'semver';

import { SCREAM_CODE_CDN_LATEST_URL } from '#/constant/app';

/**
 * Fetch the latest published Scream Code version from the CDN.
 *
 * **Throws** on any failure (network error, non-2xx, empty body, non-semver
 * text). Callers must catch — `refreshUpdateCache` deliberately lets the
 * error propagate so the existing cache stays intact instead of being
 * overwritten with a null `latest` on a transient blip.
 *
 * `fetchImpl` is injectable for tests; defaults to the global `fetch`.
 */
export async function fetchLatestVersionFromCdn(
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const response = await fetchImpl(SCREAM_CODE_CDN_LATEST_URL);
  if (!response.ok) {
    throw new Error(`CDN /latest returned HTTP ${response.status}`);
  }
  const raw = (await response.text()).trim();
  if (valid(raw) === null) {
    throw new Error(`CDN /latest returned invalid semver: ${JSON.stringify(raw)}`);
  }
  return raw;
}
