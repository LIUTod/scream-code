import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { PluginManager } from '../../src/plugin/manager';
import {
  acknowledgeQuarantine,
  appendQuarantine,
  matchQuarantine,
  readQuarantine,
  sourceKeyFromRawSource,
} from '../../src/plugin/quarantine';

/**
 * Immune memory: circuit-tripped origins are remembered across sessions so
 * the agent can warn BEFORE reinstalling from a repository that burned us.
 */

function entry(overrides: Partial<{ at: string; sourceKey: string; reason: string; acknowledgedAt: string }>) {
  return {
    at: overrides.at ?? '2026-08-27T00:00:00.000Z',
    pluginId: 'boom',
    name: 'Boom',
    sourceKey: overrides.sourceKey ?? 'github:acme/widgets',
    reason: overrides.reason ?? 'circuit tripped',
    ...(overrides.acknowledgedAt !== undefined
      ? { acknowledgedAt: overrides.acknowledgedAt }
      : {}),
  };
}

describe('quarantine ledger', () => {
  it('github URLs normalize to owner/repo keys', () => {
    expect(sourceKeyFromRawSource('https://github.com/acme/widgets/tree/v2')).toBe(
      'github:acme/widgets',
    );
    expect(sourceKeyFromRawSource('/tmp/plain-path')).toBe('/tmp/plain-path');
  });

  it('matching skips acknowledged entries and prefers the newest unacknowledged', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'quarantine-home-'));
    await appendQuarantine(home, entry({ at: '2026-08-25T00:00:00Z' }));
    const firstHit = matchQuarantine(await readQuarantine(home), 'github:acme/widgets');
    expect(firstHit?.reason).toBe('circuit tripped');

    // A second incident for the same origin is the one that warns next.
    await appendQuarantine(
      home,
      entry({ at: '2026-08-26T00:00:00Z', reason: 'tripped again' }),
    );
    const newest = matchQuarantine(await readQuarantine(home), 'github:acme/widgets');
    expect(newest?.reason).toBe('tripped again');
  });

  it('acknowledge clears EVERY unacknowledged entry for an origin (multi-trip)', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'quarantine-multi-'));
    await appendQuarantine(home, entry({ at: '2026-08-20T00:00:00Z', reason: 'first' }));
    await appendQuarantine(home, entry({ at: '2026-08-21T00:00:00Z', reason: 'second' }));
    expect(
      matchQuarantine(await readQuarantine(home), 'github:acme/widgets')?.reason,
    ).toBe('second');

    await acknowledgeQuarantine(home, 'github:acme/widgets');

    // After one acknowledge, NOTHING for this origin may still warn.
    expect(matchQuarantine(await readQuarantine(home), 'github:acme/widgets')).toBeUndefined();
  });

  it('acknowledge on an empty ledger does not create a stray file', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'quarantine-empty-'));
    await acknowledgeQuarantine(home, 'github:nobody/nothing');
    await expect(readFile(path.join(home, 'plugins', 'quarantine.json'), 'utf8')).rejects.toThrow();
  });

  it('appends are capped at 200 with the newest retained', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'quarantine-cap-'));
    for (let index = 0; index < 205; index += 1) {
      await appendQuarantine(home, {
        at: `2026-01-01T00:${String(index % 60).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.${String(index).padStart(4, '0')}Z`,
        pluginId: `p${String(index)}`,
        sourceKey: `key-${String(index)}`,
        reason: 'r',
      });
    }
    const entries = await readQuarantine(home);
    expect(entries).toHaveLength(200);
    expect(entries.at(-1)?.pluginId).toBe('p204');
  });
});

describe('PluginManager quarantine integration', () => {
  it('a tripped record quarantines by origin key and matches raw reinstall strings', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'quarantine-mgr-'));
    const manager = new PluginManager({ screamHomeDir: home });
    await manager.load();

    const root = await mkdtemp(path.join(tmpdir(), 'q-plugin-'));
    await writeFile(
      path.join(root, 'scream.plugin.json'),
      JSON.stringify({ name: 'flashy', version: '1.0.0' }),
      'utf8',
    );
    await manager.install(root);

    const appended = await manager.appendQuarantine('flashy', 'circuit tripped after 3');
    // Local installs have no github metadata, so the raw origin is the key.
    expect(typeof appended?.sourceKey === 'string' && appended.sourceKey.length > 0).toBe(true);

    const hit = await manager.matchQuarantineForSource(root);
    expect(hit?.reason).toBe('circuit tripped after 3');

    await manager.acknowledgeQuarantineForSource(root);
    expect(await manager.matchQuarantineForSource(root)).toBeUndefined();
  });
});
