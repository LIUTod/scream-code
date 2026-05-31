/**
 * Probe for the `fd` binary so the pi-tui `CombinedAutocompleteProvider`
 * can enable its cross-directory fuzzy file search.
 *
 * Naming differs across distros:
 *   - Homebrew / Arch / most Linuxes: `fd`
 *   - Debian / Ubuntu:                `fdfind`
 *
 * We use `spawnSync(..., { stdio: 'ignore' })` rather than shelling out
 * to `which` so the check doesn't depend on the parent shell's PATH
 * resolution semantics and stays cheap (~ms) on startup.
 */

import { spawnSync } from 'node:child_process';

const CANDIDATES = ['fd', 'fdfind'];

export function detectFdPath(): string | null {
  for (const name of CANDIDATES) {
    try {
      const result = spawnSync(name, ['--version'], { stdio: 'ignore' });
      if (result.status === 0) return name;
    } catch {
      // ENOENT, EACCES, etc. — try next candidate
    }
  }
  return null;
}
