import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach } from 'vitest';

/**
 * Isolate SCREAM_CODE_HOME so tests never read the developer's real
 * ~/.scream-code (e.g. user-prefs.md, config.toml, AGENTS.md). Without this,
 * any code that calls resolveScreamHome() — including UserPrefsInjector on
 * every agent turn — would leak the real user's preferences into test
 * snapshots and break isolation.
 *
 * beforeAll creates one tmp home for the whole suite; beforeEach force-resets
 * the env var so per-test mutations (e.g. config tests overriding it) don't
 * bleed into the next test.
 */
let isolatedHome: string;

beforeAll(async () => {
  isolatedHome = await mkdtemp(join(tmpdir(), 'scream-test-home-'));
});

beforeEach(() => {
  process.env['SCREAM_CODE_HOME'] = isolatedHome;
});

afterAll(async () => {
  await rm(isolatedHome, { recursive: true, force: true });
});
