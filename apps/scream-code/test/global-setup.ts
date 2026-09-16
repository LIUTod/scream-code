import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { setLocale } from '@scream-code/config';
import { afterAll } from 'vitest';

// Never read or write the developer's real data directory: the TUI stores view
// preferences there, so a value set while using the app (row budgets, elapsed
// marker, highlight) would change what the suite renders. Each test file gets its
// own empty directory instead, removed again when the file is done.
const testHome = mkdtempSync(join(tmpdir(), 'scream-test-home-'));
process.env['SCREAM_CODE_HOME'] = testHome;
afterAll(() => {
  rmSync(testHome, { recursive: true, force: true });
});

setLocale('zh');
