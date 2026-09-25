import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { valid } from 'semver';

import { npmLaunchPlan } from '#/utils/exec/npm';

const NPM_TIMEOUT_MS = 3_000;

/**
 * Query the latest published Scream Code version from the npm registry
 * via `npm view scream-code version`.
 *
 * The argv comes from `npmLaunchPlan`, so a Windows host goes through
 * `cmd.exe` — see there for why the `.cmd` shim cannot be spawned directly.
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
  const npm = npmLaunchPlan(['view', 'scream-code', 'version']);
  const { stdout } = await execAsync(npm.command, [...npm.args], {
    timeout: NPM_TIMEOUT_MS,
    maxBuffer: 1024,
    windowsVerbatimArguments: npm.windowsVerbatimArguments,
  });
  const raw = stdout.trim();
  if (valid(raw) === null) {
    throw new Error(`npm view 返回的版本号不是合法 semver: ${JSON.stringify(raw)}`);
  }
  return raw;
}
