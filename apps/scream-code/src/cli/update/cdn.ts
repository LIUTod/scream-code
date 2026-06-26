import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { valid } from 'semver';

const NPM_TIMEOUT_MS = 15_000;

/**
 * Query the latest published Scream Code version from the npm registry
 * via `npm view scream-code version`.
 *
 * **Throws** on any failure (network error, npm not in PATH, non-semver
 * output). Callers must catch — `refreshUpdateCache` deliberately lets the
 * error propagate so the existing cache stays intact instead of being
 * overwritten with a null `latest` on a transient blip.
 *
 * `execFileImpl` is injectable for tests; defaults to a promisified spawn.
 */
export async function fetchLatestVersionFromNpm(
  execFileImpl: typeof execFile = execFile,
): Promise<string> {
  const execAsync = promisify(execFileImpl);
  const { stdout } = await execAsync(
    'npm',
    ['view', 'scream-code', 'version'],
    { timeout: NPM_TIMEOUT_MS, maxBuffer: 1024, shell: true },
  );
  const raw = stdout.trim();
  if (valid(raw) === null) {
    throw new Error(`npm view 返回的版本号不是合法 semver: ${JSON.stringify(raw)}`);
  }
  return raw;
}
