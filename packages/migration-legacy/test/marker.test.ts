import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readMarker,
  writeMarker,
  appendMarkerRun,
  type MarkerData,
} from '../src/marker.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'migration-marker-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('marker', () => {
  it('readMarker returns undefined when file does not exist', async () => {
    expect(await readMarker(dir)).toBeUndefined();
  });

  it('writeMarker creates a new marker file with first_migrated_at = last_migrated_at', async () => {
    const summaryStub = { sessionsAttempted: 5 } as MarkerData['runs'][number]['summary'];
    await writeMarker(dir, {
      migratorVersion: '0.1.1',
      targetPath: '/foo',
      startedAt: '2026-05-16T10:00:00Z',
      completedAt: '2026-05-16T10:00:42Z',
      summary: summaryStub,
    });
    const data = await readMarker(dir);
    expect(data?.first_migrated_at).toBe('2026-05-16T10:00:00Z');
    expect(data?.last_migrated_at).toBe('2026-05-16T10:00:42Z');
    expect(data?.runs).toHaveLength(1);
  });

  it('appendMarkerRun appends to existing marker without losing history', async () => {
    await writeMarker(dir, {
      migratorVersion: '0.1.1',
      targetPath: '/foo',
      startedAt: '2026-05-16T10:00:00Z',
      completedAt: '2026-05-16T10:00:42Z',
      summary: {} as any,
    });
    await appendMarkerRun(dir, {
      migratorVersion: '0.2.0',
      startedAt: '2026-05-17T10:00:00Z',
      completedAt: '2026-05-17T10:00:30Z',
      summary: {} as any,
      targetPath: '/bar',
    });
    const data = await readMarker(dir);
    expect(data?.first_migrated_at).toBe('2026-05-16T10:00:00Z');
    expect(data?.last_migrated_at).toBe('2026-05-17T10:00:30Z');
    expect(data?.runs).toHaveLength(2);
    // A rerun to a different target updates target_path so the marker
    // reflects the home it most recently migrated to.
    expect(data?.target_path).toBe('/bar');
  });

  it('readMarker returns undefined when file is corrupt', async () => {
    await writeFile(join(dir, '.migrated-to-scream-code'), 'not-json', 'utf-8');
    expect(await readMarker(dir)).toBeUndefined();
  });

  it('readMarker returns undefined when version is kept but runs is missing', async () => {
    // A partially-written/hand-edited marker: treating it as absent avoids
    // appendMarkerRun throwing on `[...existing.runs, run]`.
    await writeFile(
      join(dir, '.migrated-to-scream-code'),
      JSON.stringify({ version: 1, target_path: '/foo' }),
      'utf-8',
    );
    expect(await readMarker(dir)).toBeUndefined();
  });
});
