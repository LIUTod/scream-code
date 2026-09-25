/**
 * Marketplace catalog location — `~` expansion.
 *
 * A local catalog source may be written relative to the user's home directory.
 * Both separator dialects have to expand: `~/` on a POSIX host, `~\` on
 * Windows. The Windows form used to fall through to the relative-path branch
 * and resolve against the working directory instead, so the catalog was read
 * from the wrong place (or not at all).
 *
 * `homedir()` is redirected to a temp directory so the assertion is about the
 * expansion itself, not about anything installed in the real home.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const home = vi.hoisted(() => ({ dir: '' }));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => home.dir };
});

import { loadPluginMarketplace } from '../../src/plugin/marketplace';

const CATALOG = JSON.stringify({
  version: '1.0.0',
  entries: [{ id: 'probe', displayName: 'Probe', source: 'https://example.invalid/probe.git' }],
});

describe('marketplace local source — home-directory expansion', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'marketplace-home-'));
    home.dir = dir;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Place the catalog exactly where the loader is expected to look for it. */
  async function writeCatalog(relativeToHome: string): Promise<void> {
    const target = join(home.dir, relativeToHome);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, CATALOG, 'utf8');
  }

  it('expands a Windows-style ~\\ source against the home directory', async () => {
    await writeCatalog('catalogs\\marketplace.json');

    const catalog = await loadPluginMarketplace({ source: '~\\catalogs\\marketplace.json' });

    expect(catalog.entries.map((entry) => entry.id)).toEqual(['probe']);
  });

  it('expands a POSIX-style ~/ source against the home directory', async () => {
    await writeCatalog('catalogs/marketplace.json');

    const catalog = await loadPluginMarketplace({ source: '~/catalogs/marketplace.json' });

    expect(catalog.entries.map((entry) => entry.id)).toEqual(['probe']);
  });
});
