import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { valid } from 'semver';

const NPM_TIMEOUT_MS = 3_000;

/**
 * Resolve the npm executable name for the current platform.
 *
 * On Windows, `npm` is actually `npm.cmd` — a batch file. Node's child_process
 * can execute `.cmd` files directly without `shell: true`, but only when the
 * filename includes the `.cmd` extension. Using `'npm'` without `.cmd` would
 * fail with ENOENT on Windows.
 *
 * We deliberately avoid `shell: true` because passing args alongside
 * `shell: true` triggers Node's DEP0190 deprecation warning on every spawn.
 */
function npmExecutable(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

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
    npmExecutable(),
    ['view', 'scream-code', 'version'],
    { timeout: NPM_TIMEOUT_MS, maxBuffer: 1024 },
  );
  const raw = stdout.trim();
  if (valid(raw) === null) {
    throw new Error(`npm view 返回的版本号不是合法 semver: ${JSON.stringify(raw)}`);
  }
  return raw;
}
