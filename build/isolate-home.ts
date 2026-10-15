import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll } from 'vitest';

/**
 * Redirect the home and temp directories of the test process into a throwaway
 * tree, so a suite can never read or write the developer's real user state.
 *
 * `SCREAM_CODE_HOME` isolation covers the product's own brand directory, but
 * not the fallback that runs before it: helpers such as `resolveScreamHome()`
 * fall back to `homedir()`, and packages that keep caches or stores under `~`
 * resolve them the same way. Moving `HOME` (and `USERPROFILE` on Windows) moves
 * every one of those paths at once. `TMPDIR` moves alongside it so that any
 * temporary file a test creates lands inside the same throwaway tree and is
 * deleted with it instead of accumulating in the system temp directory.
 *
 * One directory is created per test file in `beforeAll`; `afterAll` restores
 * the previous values and removes it. Vitest isolates test files in their own
 * process by default, so the mutation cannot leak from one file to the next.
 */
const ORIGINAL_ENV: Record<string, string | undefined> = {
  HOME: process.env['HOME'],
  TMPDIR: process.env['TMPDIR'],
  USERPROFILE: process.env['USERPROFILE'],
};

let isolatedHome: string | undefined;

beforeAll(() => {
  // Resolved before TMPDIR is redirected, so the tree lives under the real
  // temp directory rather than inside itself.
  isolatedHome = mkdtempSync(join(tmpdir(), 'scream-test-home-'));
  process.env['HOME'] = isolatedHome;
  process.env['TMPDIR'] = isolatedHome;
  process.env['USERPROFILE'] = isolatedHome;
});

afterAll(() => {
  // `beforeAll` may have thrown before the directory existed; without this
  // guard `rmSync(undefined)` would raise a TypeError and mask the real error.
  if (isolatedHome === undefined) return;
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  // Stores under the redirect write asynchronously in places; retrying re-walks
  // the tree when a late write lands between the walk and its removal.
  rmSync(isolatedHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
});
